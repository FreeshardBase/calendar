'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

test('Issue #196 — Google refresh token file in /tmp is cleaned up when sync_user returns early', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  await t.test('sync_user cleans up token files in /tmp when collection discovery returns early', () => {
    const pyScript = `
import sys
import os
import sqlite3
import tempfile

os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

# Create temporary SQLite DB with user and linked oauth2 account
db_fd, db_path = tempfile.mkstemp(suffix='.db')
os.close(db_fd)

token_path = "/tmp/google_token_testuser196_0.json"
config_path = "/tmp/vdir_testuser196.ini"

try:
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)")
    conn.execute("CREATE TABLE msgraph_accounts (id INTEGER PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT, target_calendar_id TEXT, created_at INTEGER, updated_at INTEGER)")

    # Encrypt fake refresh token
    encrypted_tok, iv = sync_worker.encrypt("secret_refresh_token_196", sync_worker.KEY_BYTES)
    
    # Insert oauth2 account pointing to unreachable host so discovery fails
    now_future_ms = int(10000000000000)
    conn.execute(
        "INSERT INTO linked_accounts (user_id, url, username, password_encrypted, iv, auth_type, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("testuser196", "http://127.0.0.1:59999/caldav/v2/user/user", "testuser196@example.com", encrypted_tok, iv, "oauth2", "fake_access_token", now_future_ms)
    )
    conn.commit()
    conn.close()

    os.environ["DATABASE_PATH"] = db_path
    status_tmp = tempfile.mkdtemp()
    os.environ["STATUS_ROOT"] = status_tmp
    
    # Clean up token path if it existed previously
    if os.path.exists(token_path):
        os.remove(token_path)
    if os.path.exists(config_path):
        os.remove(config_path)

    # Run sync_user which will write token file then attempt discovery and fail early
    success, err_msg = sync_worker.sync_user("testuser196")
    print(f"sync_user result: success={success}, err_msg='{err_msg}'")

    token_exists = os.path.exists(token_path)
    config_exists = os.path.exists(config_path)

    print(f"Post-run file status: token_exists={token_exists}, config_exists={config_exists}")

    assert not success, "sync_user must return False when collection discovery fails"
    assert not token_exists, f"Token file {token_path} must be cleaned up on early return!"
    assert not config_exists, f"Config file {config_path} must be cleaned up on early return!"

finally:
    if os.path.exists(db_path):
        os.remove(db_path)
    if os.path.exists(token_path):
        os.remove(token_path)
    if os.path.exists(config_path):
        os.remove(config_path)
`;

    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('token_exists=False'));
  });

  await t.test('sync_worker.py wraps OAuth2 path in try...finally for token cleanup', () => {
    const syncWorkerCode = fs.readFileSync(path.join(repoRoot, 'sync-worker/sync_worker.py'), 'utf-8');
    
    // Extract sync_user body
    const syncUserFn = syncWorkerCode.slice(
      syncWorkerCode.indexOf('def sync_user('),
      syncWorkerCode.indexOf('def process_next_job(')
    );

    // It must contain a try...finally block for updated_accounts token file removal
    assert.ok(syncUserFn.includes('updated_accounts'), 'sync_user must track updated_accounts');
    assert.ok(syncUserFn.includes('finally:'), 'sync_user must have a finally block for cleanup');
  });
});
