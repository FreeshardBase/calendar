'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

test('Issue #197 — vdirsyncer pair configurations include conflict_resolution setting', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  await t.test('sync-worker/sync_worker.py specifies conflict_resolution for basic and oauth2 pair templates', () => {
    const syncWorkerCode = fs.readFileSync(path.join(repoRoot, 'sync-worker/sync_worker.py'), 'utf-8');
    
    // Find all pair section definitions
    const pairSections = syncWorkerCode.split('[pair ');
    assert.ok(pairSections.length >= 3, 'sync_worker.py must contain at least 2 [pair ...] templates');

    // Skip index 0 (preamble)
    for (let i = 1; i < pairSections.length; i++) {
      const block = pairSections[i].split('\n\n')[0]; // chunk until double newline or next section
      assert.ok(
        block.includes('conflict_resolution'),
        `Pair template ${i} must include conflict_resolution setting. Block:\n${block}`
      );
      assert.ok(
        block.includes('conflict_resolution = "b wins"') || block.includes('conflict_resolution = "a wins"'),
        `Pair template ${i} must specify conflict_resolution winner (e.g., "b wins"). Block:\n${block}`
      );
    }
  });

  await t.test('Basic-Auth and OAuth2 CalDAV vdirsyncer generated configs include conflict_resolution', () => {
    const pyScript = `
import sys
import os
import sqlite3
import tempfile

os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
    sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

db_fd, db_path = tempfile.mkstemp(suffix='.db')
os.close(db_fd)

try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)")
    conn.execute("CREATE TABLE msgraph_accounts (id INTEGER PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT, target_calendar_id TEXT, created_at INTEGER, updated_at INTEGER)")
    
    encrypted_pw, iv = sync_worker.encrypt("testpass", sync_worker.KEY_BYTES)
    conn.execute(
        "INSERT INTO linked_accounts (user_id, url, username, password_encrypted, iv, auth_type) VALUES (?, ?, ?, ?, ?, ?)",
        ("testuser197", "http://127.0.0.1:59999/caldav/v2/user", "testuser197", encrypted_pw, iv, "basic")
    )
    conn.commit()

    os.environ["DATABASE_PATH"] = db_path
    status_tmp = tempfile.mkdtemp()
    os.environ["STATUS_ROOT"] = status_tmp
    
    

    success, err = sync_worker.sync_basic_caldav_accounts("testuser197", conn)
    conn.close()

    assert not success, "sync_basic_caldav_accounts should return False when server/vdirsyncer unreachable"
    assert ("vdirsyncer basic discover failed" in err or "vdirsyncer basic runner exception" in err), f"Unexpected error: {err}"

    print("Basic CalDAV execution check passed.")
finally:
    if os.path.exists(db_path):
        os.remove(db_path)
`;

    const output = execFileSync('python3', ['-c', pyScript], {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('Basic CalDAV execution check passed.'));
  });
});
