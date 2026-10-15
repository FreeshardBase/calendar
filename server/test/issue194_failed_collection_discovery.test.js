'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

test('Issue #194 — Failed collection discovery is not swallowed and returns job failure', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  await t.test('discover_google_collections raises an error when PROPFIND fails', () => {
    const pyScript = `
import sys
import os
os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

failed = False
try:
    # Attempting discovery against an unroutable port should fail
    sync_worker.discover_google_collections("http://127.0.0.1:59999/invalid", "fake_token")
except Exception as e:
    failed = True
    print(f"Caught expected discovery error: {e}")

assert failed, "discover_google_collections must raise an Exception on discovery failure, not return []"
`;

    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('Caught expected discovery error'));
  });

  await t.test('sync_user returns False with error message when Google collection discovery fails', () => {
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

try:
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)")
    conn.execute("CREATE TABLE msgraph_accounts (id INTEGER PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT, target_calendar_id TEXT, created_at INTEGER, updated_at INTEGER)")
    conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, calendar_id TEXT, owner_user_id TEXT, deleted_by TEXT, href TEXT, ics TEXT, created_at INTEGER)")

    # Encrypt fake refresh token
    encrypted_tok, iv = sync_worker.encrypt("fake_refresh_token", sync_worker.KEY_BYTES)
    
    # Insert oauth2 account pointing to unreachable host
    now_future_ms = int(10000000000000)
    conn.execute(
        "INSERT INTO linked_accounts (user_id, url, username, password_encrypted, iv, auth_type, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("testuser", "http://127.0.0.1:59999/caldav/v2/user/user", "testuser@example.com", encrypted_tok, iv, "oauth2", sync_worker.encrypt_token("fake_access_token", sync_worker.KEY_BYTES), now_future_ms)
    )
    conn.commit()
    conn.close()

    os.environ["DATABASE_PATH"] = db_path
    status_tmp = tempfile.mkdtemp()
    os.environ["STATUS_ROOT"] = status_tmp
    
    # Run sync_user which will attempt discovery and should fail
    success, err_msg = sync_worker.sync_user("testuser")
    print(f"sync_user result: success={success}, err_msg='{err_msg}'")

    assert not success, "sync_user must return False when collection discovery fails"
    assert "discovery" in err_msg.lower() or "connection" in err_msg.lower() or "59999" in err_msg.lower(), f"Unexpected error message: {err_msg}"

finally:
    if os.path.exists(db_path):
        os.remove(db_path)
`;

    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('success=False'));
  });

  await t.test('sync_worker.py code does not swallow discovery exceptions into empty collection list', () => {
    const syncWorkerCode = fs.readFileSync(path.join(repoRoot, 'sync-worker/sync_worker.py'), 'utf-8');
    
    // Check discover_google_collections implementation
    const discoveryFn = syncWorkerCode.slice(
      syncWorkerCode.indexOf('def discover_google_collections'),
      syncWorkerCode.indexOf('class CrossUserRestoreError')
    );

    // It must NOT catch Exception and silently return []
    const swallowedPattern = /except\s+Exception.*:\s*\n\s*print\(.*\)\s*\n\s*return\s+\[\]/s;
    assert.ok(!swallowedPattern.test(discoveryFn), 'discover_google_collections must not catch Exception and return []');
  });
});
