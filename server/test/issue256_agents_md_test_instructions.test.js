'use strict';

/**
 * Issue #256 — the `npm test` instructions in agents.md and README.md must describe the suite
 * as it actually runs:
 * - each HTTP-touching test file binds its own fixed port (hence `--test-concurrency=1`),
 *   never "ephemeral ports", and no server may be started first;
 * - the suite writes to `webcalendar.test.db` (or `DATABASE_PATH`) and wipes it (`Db.clearAll()`);
 * - the suite needs a git checkout (`git ls-files` in issue133_tracked_wal_sidecars.test.js).
 * Assertions are scoped to the `npm test` bullet / README "Tests" section, not the whole file,
 * so unrelated occurrences elsewhere (e.g. DATABASE_PATH in the docker recipe) cannot satisfy them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');

function npmTestBullet() {
  const lines = fs.readFileSync(path.join(ROOT_DIR, 'agents.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^- `(NODE_ENV=test )?npm test`/.test(l));
  assert.notEqual(start, -1, 'agents.md must have a `npm test` bullet');
  let end = start + 1;
  while (end < lines.length && !/^- /.test(lines[end]) && !/^#/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

function readmeTestsSection() {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  const m = content.match(/^### Tests\n([\s\S]*?)(?=^##)/m);
  assert.ok(m, 'README.md must have a "### Tests" section');
  return m[1];
}

test('agents.md npm test bullet: no pre-started server, no port-3000 claim', () => {
  const bullet = npmTestBullet();
  assert.doesNotMatch(bullet, /start the server first/i);
  assert.doesNotMatch(bullet, /localhost:3000/);
  assert.match(bullet, /do \*\*not\*\* start a server/i, 'must tell the reader not to start a server first');
  assert.match(bullet, /EADDRINUSE/, 'must say what a pre-started server on a test port causes');
});

test('agents.md npm test bullet: ports are fixed per file, not ephemeral', () => {
  const bullet = npmTestBullet();
  assert.doesNotMatch(bullet, /ephemeral/i, 'tests bind fixed literal ports, an ephemeral-port claim is false');
  assert.match(bullet, /its own fixed port/i);
  assert.match(bullet, /--test-concurrency=1/, 'must explain why the suite runs serially');
});

test('agents.md npm test bullet: documents the test database and that the suite wipes it', () => {
  const bullet = npmTestBullet();
  assert.match(bullet, /webcalendar\.test\.db/);
  assert.match(bullet, /DATABASE_PATH/);
  assert.match(bullet, /Db\.clearAll\(\)/);
});

test('agents.md npm test bullet: documents the git-checkout requirement', () => {
  const bullet = npmTestBullet();
  assert.match(bullet, /git checkout/i);
  assert.match(bullet, /issue133_tracked_wal_sidecars\.test\.js/);
});

test('README.md Tests section: no test server started first, no stale CalDAV-skip claim', () => {
  const section = readmeTestsSection();
  assert.doesNotMatch(section, /node server\/index\.js/, 'must not start a server before npm test');
  assert.doesNotMatch(section, /skip/i, 'CalDAV tests no longer skip (they run against a mock DAV server)');
  assert.match(section, /git checkout/i);
  assert.match(section, /webcalendar\.test\.db/);
});

test('the documented git-checkout requirement is real: the #133 check fails without .git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue256-nogit-'));
  try {
    fs.mkdirSync(path.join(dir, 'server/test'), { recursive: true });
    fs.copyFileSync(path.join(ROOT_DIR, '.gitignore'), path.join(dir, '.gitignore'));
    fs.copyFileSync(
      path.join(__dirname, 'issue133_tracked_wal_sidecars.test.js'),
      path.join(dir, 'server/test/issue133_tracked_wal_sidecars.test.js')
    );
    // NODE_TEST_CONTEXT would make the child report into this runner instead of exiting non-zero.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', 'server/test/issue133_tracked_wal_sidecars.test.js'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
    assert.notEqual(r.status, 0, 'outside a git checkout the suite must not pass');
    assert.match(r.stdout + r.stderr, /git ls-files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
