'use strict';

/**
 * Issue #138 — HIGH: the app image build downloads a native binary from GitHub with no retry,
 * and the declared node-gyp fallback cannot work on node:20-alpine
 *
 * Validates that Dockerfile (webcalendar):
 *   1. Installs build tools (python3, make, g++, sqlite-dev, build-base) for node-gyp compilation fallback on node:20-alpine.
 *   2. Configures npm fetch retries (fetch-retries / fetch-retry-maxtimeout) for downloading native binaries.
 *   3. Cleans up build dependencies (.build-deps) after npm ci to preserve small container footprint.
 *   4. Retains non-root USER node execution guard.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #138 — App Image Build Native Binary Retry & node-gyp Fallback', () => {

  test('Dockerfile installs build toolchain for node-gyp fallback on Alpine', () => {
    const dfPath = path.join(ROOT_DIR, 'Dockerfile');
    assert.ok(fs.existsSync(dfPath), 'Dockerfile must exist');
    const content = fs.readFileSync(dfPath, 'utf8');

    // Must install python3, make, g++, build-base, and sqlite-dev for node-gyp building
    assert.ok(/apk\s+add/i.test(content), 'Dockerfile must install build dependencies via apk add');
    assert.ok(/python3/i.test(content), 'Dockerfile must install python3 for node-gyp');
    assert.ok(/make/i.test(content), 'Dockerfile must install make for node-gyp');
    assert.ok(/g\+\+/i.test(content), 'Dockerfile must install g++ for node-gyp');
    assert.ok(/sqlite-dev|build-base/i.test(content), 'Dockerfile must install sqlite-dev or build-base for node-gyp native compilation');
  });

  test('Dockerfile configures npm fetch retry for native binary downloads', () => {
    const dfPath = path.join(ROOT_DIR, 'Dockerfile');
    const content = fs.readFileSync(dfPath, 'utf8');

    // Must configure npm fetch-retries (or npm_config_fetch_retries env / flag)
    const hasFetchRetries = /fetch-retries/i.test(content) || /npm_config_fetch_retries/i.test(content);
    assert.ok(hasFetchRetries, 'Dockerfile must configure fetch-retries for npm binary download resilience');
  });

  test('Dockerfile cleans up temporary build dependencies after npm ci', () => {
    const dfPath = path.join(ROOT_DIR, 'Dockerfile');
    const content = fs.readFileSync(dfPath, 'utf8');

    // Must clean up build dependencies via apk del after npm ci
    assert.ok(/apk\s+del/i.test(content), 'Dockerfile must remove build dependencies via apk del after npm ci');
  });

  test('Dockerfile preserves non-root user execution', () => {
    const dfPath = path.join(ROOT_DIR, 'Dockerfile');
    const content = fs.readFileSync(dfPath, 'utf8');

    const lines = content.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const lastUserLine = lines.filter(l => /^\s*USER\s+/i.test(l)).pop();
    assert.ok(lastUserLine, 'Dockerfile must contain a USER instruction');
    assert.ok(/USER\s+node/i.test(lastUserLine), 'Dockerfile must end with USER node');
  });

});
