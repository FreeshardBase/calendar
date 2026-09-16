'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3255';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #255 — Import Side-Effects & Unique Port Allocation Suite', async (t) => {

  await t.test('requiring server/index.js as a module must not automatically bind/listen on TCP port when PREVENT_AUTO_LISTEN is set', () => {
    process.env.PREVENT_AUTO_LISTEN = '1';
    // Clear cache to simulate fresh import
    delete require.cache[require.resolve('../index')];
    const { server } = require('../index');
    delete process.env.PREVENT_AUTO_LISTEN;
    
    assert.ok(server, 'server object must be exported from server/index.js');
    assert.strictEqual(
      server.listening,
      false,
      'requiring server/index.js as a module must not bind a TCP port as an import side effect'
    );
  });

  await t.test('test files in server/test must have unique PORT allocations', () => {
    const testDir = path.join(__dirname);
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));

    const portMap = new Map();
    const duplicatePorts = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(testDir, file), 'utf8');
      // Match active assignment lines for process.env.PORT
      const lines = content.split('\n').filter(line => !line.trim().startsWith('//'));
      const portMatches = lines.join('\n').matchAll(/process\.env\.PORT\s*=\s*(?:process\.env\.PORT\s*\|\|\s*)?['"](\d+)['"]/g);
      for (const match of portMatches) {
        const port = match[1];
        if (!portMap.has(port)) {
          portMap.set(port, []);
        }
        if (!portMap.get(port).includes(file)) {
          portMap.get(port).push(file);
        }
      }
    }

    for (const [port, filesUsingPort] of portMap.entries()) {
      if (filesUsingPort.length > 1) {
        duplicatePorts.push(`Port ${port} used by: ${filesUsingPort.join(', ')}`);
      }
    }

    assert.deepStrictEqual(
      duplicatePorts,
      [],
      `Found duplicate PORT definitions across test files:\n${duplicatePorts.join('\n')}`
    );
  });

  await t.test('exported server instance can be explicitly listened to and closed', async () => {
    process.env.PREVENT_AUTO_LISTEN = '1';
    delete require.cache[require.resolve('../index')];
    const { server } = require('../index');
    delete process.env.PREVENT_AUTO_LISTEN;
    
    assert.strictEqual(server.listening, false);

    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    assert.strictEqual(server.listening, true, 'server should be listening after explicit server.listen()');

    await new Promise((resolve) => server.close(resolve));
    assert.strictEqual(server.listening, false, 'server should not be listening after server.close()');
  });

});
