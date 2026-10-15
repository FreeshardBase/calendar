'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const rootDir = path.join(__dirname, '../..');
const configPath = path.join(rootDir, 'playwright.config.js');

// Loads playwright.config.js in a fresh process, as the Playwright runner does, without a run id inherited.
function loadConfigInFreshRunner() {
  const env = { ...process.env };
  delete env.E2E_RUN_ID;
  const out = execFileSync(process.execPath, ['-e', `
    const c = require(${JSON.stringify(configPath)});
    console.log(JSON.stringify({ retries: c.retries, trace: c.use.trace, globalTeardown: c.globalTeardown, env: c.webServer.env }));
  `], { env, cwd: rootDir, encoding: 'utf8' });
  return JSON.parse(out);
}

function startFakeRadicale(status) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.statusCode = status;
    res.end(status >= 400 ? 'refused' : '');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, url: `http://127.0.0.1:${server.address().port}`,
  })));
}

function makeRunDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcalendar-e2e-217-'));
  const databasePath = path.join(dir, 'webcalendar.db');
  fs.writeFileSync(databasePath, 'fixture');
  return { dir, databasePath };
}

test('Issue #217 — traces are kept for failures when there is no retry', () => {
  const config = loadConfigInFreshRunner();
  assert.strictEqual(config.retries, 0);
  assert.strictEqual(config.trace, 'retain-on-failure');
});

test('Issue #217 — package.json and the justfile ci recipe run the e2e suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['test:e2e'], 'playwright test');
  assert.match(pkg.scripts['test:all'], /npm test && npm run test:e2e/);

  const justfile = fs.readFileSync(path.join(rootDir, 'justfile'), 'utf8');
  const ciLine = justfile.split('\n').find(l => /^ci\s*:/.test(l));
  assert.ok(ciLine, 'justfile must define a ci recipe');
  const deps = ciLine.replace(/^ci\s*:/, '').trim().split(/\s+/);
  assert.ok(deps.includes('test') && deps.includes('test-e2e'), `ci recipe must depend on test and test-e2e, got: ${ciLine}`);
});

test('Issue #217 — every e2e run gets its own fixture user and database', (t) => {
  const a = loadConfigInFreshRunner();
  const b = loadConfigInFreshRunner();
  t.after(() => {
    for (const c of [a, b]) fs.rmSync(path.dirname(c.env.DATABASE_PATH), { recursive: true, force: true });
  });

  // Not the shared default user 'test', and never the same principal or database twice.
  assert.match(a.env.CALDAV_USERNAME, /^e2e-[a-z0-9-]+$/);
  assert.notStrictEqual(a.env.CALDAV_USERNAME, b.env.CALDAV_USERNAME);
  assert.notStrictEqual(a.env.DATABASE_PATH, b.env.DATABASE_PATH);
  assert.notStrictEqual(path.dirname(a.env.DATABASE_PATH), path.dirname(b.env.DATABASE_PATH));

  // Workers inherit E2E_RUN_ID and must resolve the same fixture as the runner.
  const out = execFileSync(process.execPath, ['-e', `
    console.log(require(${JSON.stringify(configPath)}).webServer.env.CALDAV_USERNAME);
  `], { env: { ...process.env, E2E_RUN_ID: a.env.CALDAV_USERNAME.slice(4) }, encoding: 'utf8' }).trim();
  assert.strictEqual(out, a.env.CALDAV_USERNAME);
});

test('Issue #217 — the global teardown drops the run principal on Radicale and the run database', async (t) => {
  const config = loadConfigInFreshRunner();
  t.after(() => fs.rmSync(path.dirname(config.env.DATABASE_PATH), { recursive: true, force: true }));
  assert.ok(config.globalTeardown, 'playwright.config.js must configure a globalTeardown');
  const teardown = require(path.resolve(rootDir, config.globalTeardown));
  assert.strictEqual(typeof teardown, 'function');
  const { removeRunFixtures } = teardown;

  const radicale = await startFakeRadicale(204);
  t.after(() => radicale.server.close());
  const { dir, databasePath } = makeRunDatabase();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await removeRunFixtures({ caldavUrl: radicale.url, username: 'e2e-run1', secret: 'test-secret', databasePath });

  assert.strictEqual(radicale.requests.length, 1);
  const [req] = radicale.requests;
  assert.strictEqual(req.method, 'DELETE');
  assert.strictEqual(req.url, '/e2e-run1/');
  assert.strictEqual(req.headers.authorization, 'Basic ' + Buffer.from('e2e-run1:test-secret').toString('base64'));
  assert.strictEqual(req.headers['accept-encoding'], 'identity');
  assert.strictEqual(fs.existsSync(dir), false, 'the run database directory is removed');
});

test('Issue #217 — a run that never touched Radicale tears down cleanly', async (t) => {
  const { removeRunFixtures } = require(path.join(rootDir, 'e2e/global-teardown.js'));
  const radicale = await startFakeRadicale(404);
  t.after(() => radicale.server.close());
  const { dir, databasePath } = makeRunDatabase();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await removeRunFixtures({ caldavUrl: radicale.url, username: 'e2e-run2', secret: 'test-secret', databasePath });
  assert.strictEqual(fs.existsSync(dir), false);
});

test('Issue #217 — the teardown fails loudly when Radicale refuses the delete', async (t) => {
  const { removeRunFixtures } = require(path.join(rootDir, 'e2e/global-teardown.js'));
  const radicale = await startFakeRadicale(403);
  t.after(() => radicale.server.close());
  const { dir, databasePath } = makeRunDatabase();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    removeRunFixtures({ caldavUrl: radicale.url, username: 'e2e-run3', secret: 'test-secret', databasePath }),
    /DELETE .*\/e2e-run3\/ failed: 403/
  );
});

test('Issue #217 — the teardown refuses to delete a principal that is not an e2e fixture user', async (t) => {
  const { removeRunFixtures } = require(path.join(rootDir, 'e2e/global-teardown.js'));
  const radicale = await startFakeRadicale(204);
  t.after(() => radicale.server.close());
  const { dir, databasePath } = makeRunDatabase();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    removeRunFixtures({ caldavUrl: radicale.url, username: 'test', secret: 'test-secret', databasePath }),
    /not an e2e fixture user/
  );
  assert.strictEqual(radicale.requests.length, 0, 'nothing is sent for a non-fixture principal');
  assert.ok(fs.existsSync(databasePath));
});
