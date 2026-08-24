'use strict';

/**
 * Issue #259 — Docker Quick Start & Compose Environment Fixes
 *
 * Validates Docker Quick Start configuration and container environment alignment:
 *   1. docker-compose.yml uses named volume `shared-data` across services instead of unprivileged bind mounts.
 *   2. docker-compose.yml includes env_file in caldav-server service.
 *   3. sync-worker/sync_worker.py aligns default ENCRYPTION_KEY fallback with db.js and docker-compose.yml.
 *   4. sync-worker/sync_worker.py sets SSL fallback verify = false when fingerprint is missing for local HTTPS Radicale.
 *   5. radicale/Dockerfile includes openssl and entrypoint script for missing SSL cert auto-generation.
 *   6. .dockerignore ignores data/, webcalendar.db*, ssl/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #259 — Docker Quick Start & Compose Environment Fixes', () => {

  test('docker-compose.yml mounts shared-data volume across all services', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    assert.ok(content.includes('shared-data:/app/data'),
      'webcalendar service must mount shared-data to /app/data');
    assert.ok(content.includes('shared-data:/data'),
      'caldav-server and sync-worker services must mount shared-data to /data');
    assert.ok(!content.includes('./data:/app/data'),
      'webcalendar service must not use host ./data bind mount');
    assert.ok(!content.includes('./data:/data'),
      'caldav-server and sync-worker services must not use host ./data bind mount');
  });

  test('docker-compose.yml includes .env file in caldav-server service', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');

    const caldavStartIndex = content.indexOf('caldav-server:');
    const syncWorkerIndex = content.indexOf('sync-worker:');
    const caldavSection = content.substring(caldavStartIndex, syncWorkerIndex > -1 ? syncWorkerIndex : content.length);
    assert.ok(caldavSection.includes('env_file:'), 'caldav-server must include env_file');
    assert.ok(caldavSection.includes('- .env'), 'caldav-server must reference .env');
  });

  test('sync_worker.py fallback ENCRYPTION_KEY matches db.js and docker-compose.yml', () => {
    const workerPath = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
    assert.ok(fs.existsSync(workerPath), 'sync_worker.py must exist');
    const content = fs.readFileSync(workerPath, 'utf8');

    assert.ok(content.includes('freeshard-default-encryption-key-do-not-use-in-prod'),
      'sync_worker.py must use freeshard-default-encryption-key-do-not-use-in-prod as fallback key');
    assert.ok(!content.includes('default-secret-key-32-chars-long!'),
      'sync_worker.py must not retain stale default-secret-key fallback');
  });

  test('sync_worker.py sets verify = false fallback when SSL fingerprint is absent', () => {
    const workerPath = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
    const content = fs.readFileSync(workerPath, 'utf8');

    assert.ok(
      content.includes('verify = false') || content.includes('"verify = false"'),
      'sync_worker.py must specify verify = false when fingerprint is missing'
    );
  });

  test('radicale Dockerfile includes openssl and entrypoint script', () => {
    const radicaleDockerPath = path.join(ROOT_DIR, 'radicale/Dockerfile');
    assert.ok(fs.existsSync(radicaleDockerPath), 'radicale/Dockerfile must exist');
    const content = fs.readFileSync(radicaleDockerPath, 'utf8');

    assert.ok(content.includes('openssl'), 'radicale Dockerfile must install openssl');
    assert.ok(content.includes('entrypoint.sh'), 'radicale Dockerfile must copy/use entrypoint.sh');

    const entrypointPath = path.join(ROOT_DIR, 'radicale/entrypoint.sh');
    assert.ok(fs.existsSync(entrypointPath), 'radicale/entrypoint.sh must exist');
    const entrypointContent = fs.readFileSync(entrypointPath, 'utf8');
    assert.ok(entrypointContent.includes('openssl req'),
      'entrypoint.sh must generate self-signed cert if missing');
  });

  test('.dockerignore includes runtime data and database patterns', () => {
    const ignorePath = path.join(ROOT_DIR, '.dockerignore');
    assert.ok(fs.existsSync(ignorePath), '.dockerignore must exist');
    const content = fs.readFileSync(ignorePath, 'utf8');

    assert.ok(content.includes('data/'), '.dockerignore must ignore data/');
    assert.ok(content.includes('*.db') || content.includes('webcalendar.db*'),
      '.dockerignore must ignore database files');
    assert.ok(content.includes('ssl/'), '.dockerignore must ignore ssl/');
  });

});
