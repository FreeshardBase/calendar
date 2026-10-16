'use strict';
// #398 (#358): `npm run lint` rejects a test that reads app sources (.js/.css/.html), except the
// files in source-grep-allowlist.json. The allowlist may only shrink: an entry whose file no
// longer reads sources fails here, so finished area issues must remove it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');

const ROOT = path.resolve(__dirname, '../..');
const ALLOWLIST = require('./source-grep-allowlist.json');
const RULE_ID = 'local/no-source-grep';

async function ruleHits(code, filePath) {
  // The repository's real eslint.config.js, as `npm run lint` uses it.
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
  const fatal = result.messages.find((m) => m.fatal);
  assert.equal(fatal, undefined, fatal && fatal.message);
  return result.messages.filter((m) => m.ruleId === RULE_ID);
}

const DIRECT_READ = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const src = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');",
  "module.exports = src.includes('openModal');",
].join('\n');

describe('#398 lint rule against source-grep tests', () => {
  test('flags a new test that reads a public JS file', async () => {
    const hits = await ruleHits(DIRECT_READ, 'server/test/zz_new_offender.test.js');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
    assert.equal(hits[0].severity, 2, 'must be an error so npm run lint fails');
  });

  test('flags reads through a path variable, a loop over file names and a read helper', async () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const ROOT = path.join(__dirname, '../..');",
      "const cssPath = path.join(ROOT, 'public', 'css', 'app.css');",
      "const css = fs.readFileSync(cssPath, 'utf8');",
      "for (const name of ['index.js', 'db.js']) fs.readFileSync(path.join(ROOT, 'server', name), 'utf8');",
      "function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }",
      "const html = read('public/index.html');",
      'module.exports = css + html;',
    ].join('\n');
    const hits = await ruleHits(code, 'server/test/zz_new_offender.test.js');
    assert.deepEqual(hits.map((h) => h.line), [5, 6, 8]);
  });

  test('ignores parsed configuration, required modules and supertest URLs', async () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const routes = require('../routes/calendars.js');",
      "const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));",
      "const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'testuser.key'), 'utf8');",
      "const url = '/js/app.js';",
      'module.exports = { routes, pkg, key, url };',
    ].join('\n');
    assert.deepEqual(await ruleHits(code, 'server/test/zz_new_offender.test.js'), []);
  });

  test('does not flag a file on the allowlist', async () => {
    assert.ok(ALLOWLIST.length > 0);
    assert.deepEqual(await ruleHits(DIRECT_READ, ALLOWLIST[0]), []);
  });

  test('allowlist is a sorted list of existing server/test files without duplicates', () => {
    assert.ok(Array.isArray(ALLOWLIST));
    assert.deepEqual(ALLOWLIST, [...new Set(ALLOWLIST)].sort());
    for (const file of ALLOWLIST) {
      assert.match(file, /^server\/test\/.+\.js$/);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is on the allowlist but does not exist: remove it`);
    }
  });

  test('allowlist only shrinks: every entry still reads app sources, and no other test does', async () => {
    const { listSourceGrepTests } = require('../../scripts/list-source-grep-tests');
    const offenders = await listSourceGrepTests();
    const stale = ALLOWLIST.filter((f) => !offenders.includes(f));
    assert.deepEqual(stale, [], 'these files no longer read app sources: remove them from server/test/source-grep-allowlist.json');
    const unlisted = offenders.filter((f) => !ALLOWLIST.includes(f));
    assert.deepEqual(unlisted, [], 'these tests read app sources: test behaviour instead (supertest, jsdom, Playwright)');
  });

  test('the shrink check fires when an entry stops reading sources', async () => {
    const { listSourceGrepTests } = require('../../scripts/list-source-grep-tests');
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'source-grep-'));
    fs.mkdirSync(path.join(tmp, 'server/test'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'server/test/reads.test.js'), DIRECT_READ);
    fs.writeFileSync(path.join(tmp, 'server/test/clean.test.js'), "const request = require('supertest');\nmodule.exports = request;\n");
    try {
      assert.deepEqual(await listSourceGrepTests(tmp), ['server/test/reads.test.js']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
