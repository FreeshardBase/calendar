'use strict';

/**
 * Issue #536 — sync-worker image hygiene.
 *
 * Images cannot be built in the test environment, so the Dockerfile is parsed into its build stages
 * (as Docker does: a stage starts at FROM, the last stage is the image) and the lock file into its
 * requirements. Checked:
 *   1. The runtime stage installs no build toolchain and does not install from PyPI itself.
 *   2. Nothing under /app (code) is handed to the service uid; only the data directories are.
 *   3. Every install runs `pip install --require-hashes --only-binary=:all:` against the lock, and
 *      the lock pins every requirement with `==` and at least one sha256.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../../sync-worker');

// Dockerfile instructions with line continuations joined, comments dropped.
function instructions() {
  const joined = fs.readFileSync(path.join(DIR, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
  return joined.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function stages() {
  const out = [];
  for (const line of instructions()) {
    if (/^FROM\s/i.test(line)) out.push([]);
    assert.ok(out.length, `instruction before FROM: ${line}`);
    out[out.length - 1].push(line);
  }
  return out;
}

function requirementLines(file) {
  const p = path.join(DIR, file);
  assert.ok(fs.existsSync(p), `sync-worker/${file} must exist`);
  const joined = fs.readFileSync(p, 'utf8').replace(/\\\r?\n/g, ' ');
  return joined.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
}

const normalize = name => name.toLowerCase().replace(/[._]/g, '-');

const TOOLCHAIN = /\b(gcc|g\+\+|cc|clang|libc-dev|libc6-dev|libffi-dev|libssl-dev|build-essential|make|python3-dev|rustc|cargo)\b/;
const PIP_INSTALL = /\bpip3?\s+install|-m\s+pip\s+install|\buv\s+pip\s+install/;

test.describe('Issue #536 — sync-worker image', () => {
  test('the runtime stage carries no build toolchain and runs no pip install', () => {
    const all = stages();
    assert.ok(all.length >= 2, 'the Dockerfile must be a multi-stage build');
    const runtime = all[all.length - 1];
    // A final stage built FROM an earlier stage would inherit its toolchain.
    const aliases = all.slice(0, -1).map(s => (s[0].match(/\sAS\s+(\S+)/i) || [])[1]).filter(Boolean);
    const base = runtime[0].split(/\s+/).find((w, i) => i > 0 && !w.startsWith('--'));
    assert.ok(!aliases.map(a => a.toLowerCase()).includes(base.toLowerCase()), `runtime stage is built on stage ${base}`);
    for (const line of runtime.filter(l => /^RUN\s/i.test(l))) {
      assert.doesNotMatch(line, TOOLCHAIN, `runtime stage installs a build tool: ${line}`);
      assert.doesNotMatch(line, PIP_INSTALL, `runtime stage installs packages itself: ${line}`);
    }
    assert.ok(runtime.some(l => /^COPY\s+--from=/i.test(l)), 'runtime stage must copy the installed packages from the build stage');
  });

  test('no instruction gives /app to the service uid; the data dirs are its only directories', () => {
    const runtime = stages().pop();
    for (const line of runtime) {
      for (const m of line.matchAll(/chown\s+(?:-\S+\s+)*(\S+)\s+([^&;]+)/g)) {
        const targets = m[2].trim().split(/\s+/);
        for (const t of targets) {
          assert.ok(!t.startsWith('/app') && !t.startsWith('/opt'), `${line}: chowns ${t} to ${m[1]}`);
        }
      }
      assert.doesNotMatch(line, /^(COPY|ADD)\s.*--(chown|chmod)/i, `code is copied with its owner or mode changed: ${line}`);
      assert.doesNotMatch(line, /chmod\s+(-R\s+)?\S*(\+[rwxX]*w|[0-7]?[0-7][0-7][2367])\S*\s+\/app/, `code made writable for others: ${line}`);
      assert.doesNotMatch(line, /setfacl/, `ACLs on code: ${line}`);
    }
    assert.ok(runtime.some(l => /chown\s+-R\s+syncworker:syncworker\s+\/data(\s|$)/.test(l)), 'the data dir must belong to the service uid');
  });

  test('every pip install is hash-locked and wheel-only, and the lock pins everything with a hash', () => {
    // Each shell command of a RUN on its own: a second, unhashed install in the same RUN must not hide.
    const installs = instructions().flatMap(l => l.split(/&&|\|\||;/)).filter(l => PIP_INSTALL.test(l));
    assert.ok(installs.length > 0, 'the image must install the lock');
    for (const line of installs) {
      assert.match(line, /--require-hashes/, `install without --require-hashes: ${line}`);
      assert.match(line, /--only-binary=:all:/, `install may build from source: ${line}`);
      assert.match(line, /-r\s+\S*\/locked-requirements\.txt(\s|$)/, `install not from the lock: ${line}`);
    }

    const locked = new Map();
    for (const req of requirementLines('locked-requirements.txt')) {
      const m = req.match(/^([A-Za-z0-9._-]+)(\[[^\]]+\])?==([^\s;]+)((?:\s+--hash=sha256:[0-9a-f]{64})+)$/);
      assert.ok(m, `lock entry is not '<name>==<version> --hash=sha256:...': ${req}`);
      locked.set(normalize(m[1]), m[3]);
    }
    for (const transitive of ['aiohttp', 'cffi', 'requests', 'oauthlib', 'yarl']) {
      assert.ok(locked.has(transitive), `lock must pin the transitive dependency ${transitive}`);
    }
  });

  test('the lock pins every direct requirement at the version requirements.txt names', () => {
    const direct = requirementLines('requirements.txt');
    assert.ok(direct.length >= 2);
    const locked = new Map(requirementLines('locked-requirements.txt').map(req => {
      const m = req.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?==(\S+)/);
      return [normalize(m[1]), m[2]];
    }));
    for (const req of direct) {
      const m = req.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?==(\S+)$/);
      assert.ok(m, `requirements.txt entry must be pinned with ==: ${req}`);
      assert.equal(locked.get(normalize(m[1])), m[2], `locked version of ${m[1]}`);
    }
  });
});
