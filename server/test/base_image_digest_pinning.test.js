'use strict';

/**
 * Issue #557 — every container base image is pinned by tag plus multi-arch index digest.
 *
 * A moving tag lets a rebuild silently pick up a different image. Each FROM line in the three
 * Dockerfiles must name `<image>:<tag>@sha256:<64 hex>`; the tag stays for readability.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const DOCKERFILES = ['Dockerfile', 'radicale/Dockerfile', 'sync-worker/Dockerfile'];
const PINNED_REF = /^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}$/;

// Returns the image reference of every FROM instruction (comment lines dropped first, as Docker
// does, then line continuations joined; flags such as --platform skipped).
function fromImages(content) {
  const joined = content
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\r?\n/g, ' ');
  const images = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^FROM\s/i.test(line)) continue;
    const words = line.split(/\s+/).slice(1).filter((w) => !w.startsWith('--'));
    assert.ok(words.length > 0, `FROM line without image: ${line}`);
    images.push(words[0]);
  }
  return images;
}

test.describe('Issue #557 — base images pinned by tag and sha256 digest', () => {
  test('the FROM parser rejects moving tags and accepts tag@digest', () => {
    const digest = 'a'.repeat(64);
    assert.deepEqual(fromImages(`FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:${digest} AS b\n# FROM x\n`),
      [`node:22-alpine@sha256:${digest}`]);
    assert.deepEqual(fromImages('# see README \\\nFROM node:22-alpine\n'), ['node:22-alpine'],
      'a comment ending in a backslash must not hide the next FROM');
    assert.ok(PINNED_REF.test(`node:22-alpine@sha256:${digest}`));
    assert.ok(!PINNED_REF.test('node:22-alpine'));
    assert.ok(!PINNED_REF.test(`node@sha256:${digest}`), 'tag must stay in front of the digest');
    assert.ok(!PINNED_REF.test(`node:22-alpine@sha256:${'a'.repeat(63)}`));
    assert.ok(!PINNED_REF.test(`node:22-alpine@sha256:${'A'.repeat(64)}`));
  });

  for (const rel of DOCKERFILES) {
    test(`${rel}: every FROM line pins <image>:<tag>@sha256:<64 hex>`, () => {
      const images = fromImages(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8'));
      assert.ok(images.length > 0, `${rel} has no FROM line`);
      for (const image of images) {
        assert.match(image, PINNED_REF, `${rel}: base image "${image}" is not pinned by tag@sha256 digest`);
      }
    });
  }

  test('the three Dockerfiles use the maintainer-verified multi-arch index digests', () => {
    const expected = {
      'Dockerfile': ['node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402'],
      'radicale/Dockerfile': ['python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1'],
      'sync-worker/Dockerfile': [
        'python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1',
        'python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1',
      ],
    };
    for (const [rel, images] of Object.entries(expected)) {
      assert.deepEqual(fromImages(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')), images, rel);
    }
  });
});
