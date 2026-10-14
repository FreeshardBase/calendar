'use strict';

/**
 * Issue #99 — HIGH: sync-worker/msgraph_worker.py is copied into no image and invoked by nothing
 *
 * Verification suite:
 *   1. Asserts sync-worker/Dockerfile copies msgraph_worker.py into the container image.
 *   2. Asserts sync-worker/Dockerfile grants executable permissions (+x) to msgraph_worker.py.
 *   3. Asserts sync_worker.py imports sync_msgraph_accounts directly from msgraph_worker without falling back to dummy no-op.
 *   4. Asserts python execution of sync_worker.py correctly invokes msgraph_worker.py sync_msgraph_accounts routine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharedTestDbKeyEnv = require('./helpers/sharedTestDbKeyEnv');
const path = require('node:path');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '../..');
const SYNC_WORKER_DIR = path.join(ROOT_DIR, 'sync-worker');
const DOCKERFILE_PATH = path.join(SYNC_WORKER_DIR, 'Dockerfile');

test.describe('Issue #99 — sync-worker/msgraph_worker.py Container Packaging & Invocation', () => {

  test('sync-worker/Dockerfile explicitly copies msgraph_worker.py into container image', () => {
    assert.ok(fs.existsSync(DOCKERFILE_PATH), 'sync-worker/Dockerfile must exist');
    const dockerfileContent = fs.readFileSync(DOCKERFILE_PATH, 'utf8');

    const copyMsgraphRegex = /COPY\s+.*msgraph_worker\.py/i;
    assert.ok(
      copyMsgraphRegex.test(dockerfileContent),
      'sync-worker/Dockerfile must contain a COPY instruction for msgraph_worker.py'
    );
  });

  test('sync-worker/Dockerfile sets executable permissions for msgraph_worker.py', () => {
    const dockerfileContent = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
    const chmodRegex = /RUN\s+chmod\s+\+x\s+.*msgraph_worker\.py/i;
    assert.ok(
      chmodRegex.test(dockerfileContent),
      'sync-worker/Dockerfile must grant executable permissions (+x) to msgraph_worker.py'
    );
  });

  test('sync_worker.py imports sync_msgraph_accounts directly from msgraph_worker.py', () => {
    const code = [
      'import sys, os',
      `sys.path.insert(0, '${SYNC_WORKER_DIR}')`,
      'import msgraph_worker',
      'import sync_worker',
      'assert hasattr(sync_worker, "sync_msgraph_accounts")',
      'assert sync_worker.sync_msgraph_accounts.__module__ == "msgraph_worker"',
      'print("OK")'
    ].join('\n');

    const out = execSync('python3', { input: code, encoding: 'utf8' });
    assert.ok(out.includes('OK'), 'sync_worker must import sync_msgraph_accounts from msgraph_worker');
  });

  test('sync_worker.py sync_user invokes sync_msgraph_accounts routine from msgraph_worker.py', () => {
    const testDbPath = path.join(ROOT_DIR, 'test_issue99_temp.db');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    try {
      const code = [
        'import sys, os, sqlite3',
        `sys.path.insert(0, '${SYNC_WORKER_DIR}')`,
        'import sync_worker',
        'import msgraph_worker',
        `conn = sqlite3.connect('${testDbPath}')`,
        'cursor = conn.cursor()',
        'cursor.execute("CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT, target_calendar_id TEXT, updated_at INTEGER)")',
        'cursor.execute("CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)")',
        "cursor.execute(\"INSERT INTO msgraph_accounts VALUES ('acc1', 'u99', 'common', 'cid', 'test@example.com', 'tok', 'ref', 9999999999999, NULL, 'persoenlich', 0)\")",
        'conn.commit()',
        'conn.close()',
        // Graph answers with an empty delta page; an unreachable Graph API fails the sync (#343).
        'from unittest.mock import MagicMock, patch',
        'page = MagicMock()',
        "page.__enter__.return_value.read.return_value = b'{\"value\": []}'",
        "patch.object(msgraph_worker.urllib.request, 'urlopen', return_value=page).start()",
        "res, err = sync_worker.sync_user('u99')",
        'print(f"RES:{res},ERR:{err}")'
      ].join('\n');

      const out = execSync('python3', {
        input: code,
        env: { ...process.env, ...sharedTestDbKeyEnv, DATABASE_PATH: testDbPath },
        encoding: 'utf8'
      });
      assert.ok(out.includes('RES:True'), 'sync_user must complete successfully with msgraph_worker imported');
    } finally {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    }
  });

});
