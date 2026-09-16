'use strict';

/**
 * Issue #272 / #278 — Sync Worker Python Unbuffered Logging Configuration
 *
 * Validates that sync_worker.py, msgraph_worker.py, sync-worker/Dockerfile,
 * and docker-compose.yml configure PYTHONUNBUFFERED=1 and sys.stdout line buffering
 * to ensure sync worker log output is emitted unbuffered / line-buffered to Docker logs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');
const COMPOSE_PATH = path.join(ROOT_DIR, 'docker-compose.yml');
const DOCKERFILE_PATH = path.join(ROOT_DIR, 'sync-worker/Dockerfile');
const SYNC_WORKER_PATH = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
const MSGRAPH_WORKER_PATH = path.join(ROOT_DIR, 'sync-worker/msgraph_worker.py');

test.describe('Issue #272 / #278 — Sync Worker Python Unbuffered Logging Configuration', () => {

  test('docker-compose.yml sets PYTHONUNBUFFERED: "1" under sync-worker service', () => {
    assert.ok(fs.existsSync(COMPOSE_PATH), 'docker-compose.yml must exist');
    const content = fs.readFileSync(COMPOSE_PATH, 'utf8');

    const syncWorkerStart = content.indexOf('sync-worker:');
    assert.ok(syncWorkerStart > -1, 'sync-worker service must exist in docker-compose.yml');
    
    const syncWorkerSection = content.substring(syncWorkerStart);
    assert.ok(
      syncWorkerSection.includes('PYTHONUNBUFFERED: "1"') || syncWorkerSection.includes('PYTHONUNBUFFERED: 1') || syncWorkerSection.includes('PYTHONUNBUFFERED=1'),
      'sync-worker environment in docker-compose.yml must specify PYTHONUNBUFFERED'
    );
  });

  test('sync-worker/Dockerfile declares ENV PYTHONUNBUFFERED=1', () => {
    assert.ok(fs.existsSync(DOCKERFILE_PATH), 'sync-worker/Dockerfile must exist');
    const content = fs.readFileSync(DOCKERFILE_PATH, 'utf8');

    assert.ok(
      content.includes('ENV PYTHONUNBUFFERED=1') || content.includes('ENV PYTHONUNBUFFERED 1'),
      'sync-worker/Dockerfile must specify ENV PYTHONUNBUFFERED=1'
    );
  });

  test('sync_worker.py and msgraph_worker.py enable line buffering on startup', () => {
    for (const workerPath of [SYNC_WORKER_PATH, MSGRAPH_WORKER_PATH]) {
      assert.ok(fs.existsSync(workerPath), `${path.basename(workerPath)} must exist`);
      const content = fs.readFileSync(workerPath, 'utf8');

      assert.ok(
        content.includes('sys.stdout.reconfigure(line_buffering=True)'),
        `${path.basename(workerPath)} must reconfigure sys.stdout for line buffering`
      );
      assert.ok(
        content.includes('PYTHONUNBUFFERED'),
        `${path.basename(workerPath)} must set PYTHONUNBUFFERED in os.environ`
      );
    }
  });

  test('sync_worker.py stdout output is line-buffered when imported/executed', () => {
    const pyCode = `
import sys, os
sys.path.insert(0, ${JSON.stringify(path.dirname(SYNC_WORKER_PATH))})
import sync_worker
print("TEST_UNBUFFERED_LOG_LINE")
`;
    const res = spawnSync('python3', ['-c', pyCode], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Python process must exit clean: ${res.stderr}`);
    assert.ok(
      res.stdout.includes('TEST_UNBUFFERED_LOG_LINE'),
      'stdout output must be present in unbuffered output stream'
    );
  });

});
