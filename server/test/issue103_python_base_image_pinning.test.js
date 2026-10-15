'use strict';

/**
 * Issue #103 — the two Python images must build on a pinned interpreter.
 *
 * `python:3-slim` is the same image as bare `python:slim`: it follows the newest Python major
 * and the newest Debian release, so two builds of the same commit can run the pinned Radicale
 * and vdirsyncer on different interpreters. The base image of every stage of both Dockerfiles
 * must name a concrete Python minor and Debian release.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const PYTHON_IMAGES = ['radicale/Dockerfile', 'sync-worker/Dockerfile'];

// Returns the image reference of every FROM instruction, with ARG defaults declared before
// the first FROM substituted, the way `docker build` resolves them without --build-arg.
function baseImages(dockerfile) {
  const lines = dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const args = {};
  const images = [];
  for (const line of lines) {
    const [instruction, ...rest] = line.split(/\s+/);
    const keyword = instruction.toUpperCase();
    if (keyword === 'ARG' && images.length === 0) {
      const [name, value] = rest.join(' ').split('=');
      args[name] = value === undefined ? '' : value.replace(/^["']|["']$/g, '');
    } else if (keyword === 'FROM') {
      const ref = rest.filter((tok) => !tok.startsWith('--'))[0];
      images.push(ref.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => {
        assert.ok(name in args, `FROM references undeclared ARG ${name}`);
        return args[name];
      }));
    }
  }
  return images;
}

// A Python base image counts as pinned when its tag names the Python minor and a named Debian
// release (e.g. 3.12-slim-trixie), optionally with a digest. Anything else floats.
function isPinnedPythonImage(ref) {
  const match = ref.match(/^(?:docker\.io\/)?(?:library\/)?python:3\.\d+(?:\.\d+)?-slim-([a-z]+)(?:@sha256:[0-9a-f]{64})?$/);
  return Boolean(match) && !['sid', 'testing', 'stable', 'latest'].includes(match[1]);
}

test.describe('Issue #103 — Python base images are pinned', () => {
  test('the pin check rejects the floating tags this issue names', () => {
    for (const ref of ['python:3-slim', 'python:slim', 'python:latest', 'python', 'python:3.12-slim', 'python:3-slim-trixie',
      'python:3.12-slim-sid', `alpine@sha256:${'a'.repeat(64)}`]) {
      assert.equal(isPinnedPythonImage(ref), false, `${ref} must count as floating`);
    }
    for (const ref of ['python:3.12-slim-trixie', 'python:3.12.11-slim-bookworm',
      `python:3.12-slim-trixie@sha256:${'a'.repeat(64)}`]) {
      assert.equal(isPinnedPythonImage(ref), true, `${ref} must count as pinned`);
    }
    assert.deepEqual(baseImages('ARG PY=3.12-slim-trixie\nFROM python:${PY} AS build\nFROM --platform=linux/amd64 python:$PY\n'),
      ['python:3.12-slim-trixie', 'python:3.12-slim-trixie']);
  });

  for (const rel of PYTHON_IMAGES) {
    test(`${rel} builds every stage on a pinned Python base image`, () => {
      const images = baseImages(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8'));
      assert.ok(images.length > 0, `${rel} must have a FROM instruction`);
      for (const ref of images) {
        assert.ok(isPinnedPythonImage(ref), `${rel}: base image "${ref}" floats; pin the Python minor and Debian release`);
      }
    });
  }

  test('both Python images run the same interpreter', () => {
    const minors = PYTHON_IMAGES.map((rel) => {
      const ref = baseImages(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')).at(-1);
      return (ref.match(/python:(3\.\d+)/) || [])[1];
    });
    assert.ok(minors[0], 'radicale base image must name its Python minor');
    assert.equal(minors[1], minors[0], 'radicale and sync-worker must share one Python minor');
  });
});
