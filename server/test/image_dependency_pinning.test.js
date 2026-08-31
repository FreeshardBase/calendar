'use strict';

/**
 * Issue #103 — HIGH: two of the three images pin no dependencies at all
 *
 * Validates dependency pinning across all three container images:
 *   1. Dockerfile (webcalendar) pins node dependencies via package*.json and npm ci.
 *   2. radicale/requirements.txt exists and explicitly pins radicale.
 *   3. radicale/Dockerfile installs dependencies via requirements.txt.
 *   4. sync-worker/requirements.txt exists and explicitly pins vdirsyncer[google] (>= 0.19) and cryptography.
 *   5. sync-worker/Dockerfile installs dependencies via requirements.txt.
 *   6. Asserts no Dockerfile executes unpinned bare pip installs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #103 — Container Image Dependency Pinning', () => {

  test('Dockerfile (webcalendar) uses package*.json and npm ci for dependency pinning', () => {
    const dfPath = path.join(ROOT_DIR, 'Dockerfile');
    assert.ok(fs.existsSync(dfPath), 'Dockerfile must exist');
    const content = fs.readFileSync(dfPath, 'utf8');

    assert.ok(content.includes('package*.json'), 'Dockerfile must copy package*.json');
    assert.ok(/npm\s+ci/i.test(content), 'Dockerfile must use npm ci to install pinned dependencies');
  });

  test('radicale/requirements.txt exists and explicitly pins radicale version', () => {
    const reqPath = path.join(ROOT_DIR, 'radicale/requirements.txt');
    assert.ok(fs.existsSync(reqPath), 'radicale/requirements.txt must exist');
    const content = fs.readFileSync(reqPath, 'utf8');

    assert.ok(/radicale\s*([=><~]=?\s*[0-9\.]+)/i.test(content), 'radicale/requirements.txt must pin radicale version');
  });

  test('radicale/Dockerfile uses requirements.txt for pip installation', () => {
    const dfPath = path.join(ROOT_DIR, 'radicale/Dockerfile');
    assert.ok(fs.existsSync(dfPath), 'radicale/Dockerfile must exist');
    const content = fs.readFileSync(dfPath, 'utf8');

    assert.ok(/COPY\s+.*requirements\.txt/i.test(content), 'radicale/Dockerfile must copy requirements.txt');
    assert.ok(/pip\s+install.*-r\s+.*requirements\.txt/i.test(content), 'radicale/Dockerfile must install from requirements.txt');
    assert.ok(!/pip\s+install\s+(--[a-z-]+\s+)*radicale(\s|$)/i.test(content), 'radicale/Dockerfile must not use unpinned bare "pip install radicale"');
  });

  test('sync-worker/requirements.txt exists and pins vdirsyncer[google] and cryptography', () => {
    const reqPath = path.join(ROOT_DIR, 'sync-worker/requirements.txt');
    assert.ok(fs.existsSync(reqPath), 'sync-worker/requirements.txt must exist');
    const content = fs.readFileSync(reqPath, 'utf8');

    assert.ok(/vdirsyncer(\[google\])?\s*([=><~]=?\s*[0-9\.]+)/i.test(content), 'sync-worker/requirements.txt must pin vdirsyncer version');
    assert.ok(/cryptography\s*([=><~]=?\s*[0-9\.]+)/i.test(content), 'sync-worker/requirements.txt must pin cryptography version');

    const vdirMatch = content.match(/vdirsyncer(?:\[google\])?\s*(?:==|>=|~=)\s*([0-9\.]+)/i);
    assert.ok(vdirMatch, 'vdirsyncer version string must match expected format');
    const versionNum = parseFloat(vdirMatch[1]);
    assert.ok(versionNum >= 0.19, `vdirsyncer version (${vdirMatch[1]}) must be >= 0.19`);
  });

  test('sync-worker/Dockerfile uses requirements.txt for pip installation', () => {
    const dfPath = path.join(ROOT_DIR, 'sync-worker/Dockerfile');
    assert.ok(fs.existsSync(dfPath), 'sync-worker/Dockerfile must exist');
    const content = fs.readFileSync(dfPath, 'utf8');

    assert.ok(/COPY\s+.*requirements\.txt/i.test(content), 'sync-worker/Dockerfile must copy requirements.txt');
    assert.ok(/pip\s+install.*-r\s+.*requirements\.txt/i.test(content), 'sync-worker/Dockerfile must install from requirements.txt');
    assert.ok(!/pip\s+install\s+(--[a-z-]+\s+)*"vdirsyncer\[google\]"/i.test(content), 'sync-worker/Dockerfile must not use unpinned bare "pip install vdirsyncer"');
  });

});
