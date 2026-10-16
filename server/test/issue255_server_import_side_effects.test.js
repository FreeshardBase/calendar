'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3255';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('Issue #255 — importing server/index.js yields an app, not a listener', async (t) => {

  await t.test('requiring server/index.js under NODE_ENV=test binds no port, even after Db.ready', async () => {
    delete require.cache[require.resolve('../index')];
    const { server } = require('../index');
    await require('../db').ready;
    await new Promise((resolve) => setImmediate(resolve));

    const listening = server.listening;
    const connected = await canConnect(Number(process.env.PORT));
    // Close a stray listener so a regression fails this test instead of hanging the file.
    if (listening) await new Promise((resolve) => server.close(resolve));
    assert.strictEqual(listening, false, 'importing server/index.js must not bind a TCP port');
    assert.strictEqual(connected, false, `nothing may accept connections on :${process.env.PORT}`);
  });

  await t.test('the exported server binds only when told to, and closes again', async () => {
    const { server } = require('../index');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    assert.strictEqual(server.listening, true);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => server.close(resolve));
    assert.strictEqual(server.listening, false);
  });

  await t.test('test files ignore an exported PORT that a foreign server already holds', async () => {
    // .env.example suggests PORT=3000; a developer with it exported must still get the full suite.
    const foreign = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => foreign.listen(0, resolve));
    const occupiedPort = foreign.address().port;
    try {
      const env = { ...process.env, PORT: String(occupiedPort) };
      delete env.NODE_TEST_CONTEXT;
      const { code, output } = await runNode([
        '--test', '--test-concurrency=2',
        'server/test/routes.test.js',
        'server/test/public_share.test.js',
      ], env);
      assert.doesNotMatch(output, /EADDRINUSE/, output);
      assert.strictEqual(code, 0, output);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  });

  await t.test('test files in server/test pin unique PORT literals that an exported PORT cannot override', () => {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
    const portMap = new Map();
    const overridable = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf8')
        .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      if (/process\.env\.PORT\s*=\s*process\.env\.PORT\s*(\|\||\?\?)/.test(content)) overridable.push(file);
      for (const match of content.matchAll(/process\.env\.PORT\s*=\s*['"](\d+)['"]/g)) {
        if (match[1] === '0') continue;
        if (!portMap.has(match[1])) portMap.set(match[1], new Set());
        portMap.get(match[1]).add(file);
      }
    }

    const duplicates = [...portMap].filter(([, users]) => users.size > 1)
      .map(([port, users]) => `Port ${port} used by: ${[...users].join(', ')}`);
    assert.deepStrictEqual(overridable, [], 'these test files let an exported PORT override their port');
    assert.deepStrictEqual(duplicates, [], `duplicate PORT literals:\n${duplicates.join('\n')}`);
  });
});
