'use strict';

/**
 * Issue #359 — repo hygiene: no ignored file stays in the index, scratch and
 * secret paths are ignored, one licence file, and the contributor docs
 * (README.md + agents.md) name the Node version and SQLite driver the project
 * actually requires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');
const DOCS = ['README.md', 'agents.md'];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8' });
}

function trackedFiles() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

test('Issue #359 — no tracked file matches .gitignore', () => {
  const trackedButIgnored = git(['ls-files', '--cached', '--ignored', '--exclude-standard'])
    .split('\n').filter(Boolean);
  assert.deepEqual(trackedButIgnored, [], `tracked files that .gitignore excludes:\n${trackedButIgnored.join('\n')}`);
});

test('Issue #359 — scratch files, Python caches and key sidecars are ignored and untracked', () => {
  const paths = [
    'scratch/notes.txt',
    'scratchpad.md',
    'sync-worker/__pycache__/sync_worker.cpython-312.pyc',
    '.encryption_key',
    '.share_key',
    '.session_secret',
  ];
  for (const p of paths) {
    // check-ignore exits 1 (throws) when the path is not ignored
    assert.equal(git(['check-ignore', '--no-index', p]).trim(), p, `${p} must be ignored`);
  }
  const tracked = trackedFiles();
  const offenders = tracked.filter(f =>
    f.startsWith('scratch/') || f === 'scratchpad.md' || f.includes('__pycache__/') ||
    ['.encryption_key', '.share_key', '.session_secret'].includes(path.basename(f)) ||
    ['calendar-agent-brief.md'].includes(f));
  assert.deepEqual(offenders, []);
});

test('Issue #359 — exactly one licence file is tracked', () => {
  const licences = trackedFiles().filter(f => /^LICEN[CS]E(\.\w+)?$/i.test(f));
  assert.deepEqual(licences, ['LICENSE']);
});

test('Issue #359 — contributor docs name the Node version that package.json requires', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const required = Number(/(\d+)/.exec(pkg.engines.node)[1]);
  const dockerMajor = Number(/^FROM node:(\d+)/m.exec(fs.readFileSync(path.join(ROOT_DIR, 'Dockerfile'), 'utf8'))[1]);
  assert.equal(dockerMajor, required, 'Dockerfile base image and package.json engines disagree');

  let mentions = 0;
  for (const doc of DOCS) {
    const content = fs.readFileSync(path.join(ROOT_DIR, doc), 'utf8');
    for (const m of content.matchAll(/\bNode(?:\.js)?\s*(?:>=\s*|v)?(\d{2})\b/g)) {
      mentions++;
      assert.equal(Number(m[1]), required, `${doc} says "${m[0]}", package.json requires Node ${required}`);
    }
  }
  assert.ok(mentions > 0, 'the contributor docs must state the required Node version');
});

test('Issue #359 — contributor docs name the sqlite3 driver the server depends on', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.sqlite3, 'server depends on sqlite3');
  assert.equal(pkg.dependencies['better-sqlite3'], undefined);
  for (const doc of DOCS) {
    const content = fs.readFileSync(path.join(ROOT_DIR, doc), 'utf8');
    assert.ok(!content.includes('better-sqlite3'), `${doc} must not mention better-sqlite3`);
  }
});
