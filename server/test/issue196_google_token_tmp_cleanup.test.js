'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');

test('Issue #196 — Google refresh token file is private and cleaned up when sync_user returns early', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  // Issue #334: the token file lives in a private per-run directory (0700), is itself 0600,
  // and the whole directory is removed when sync_user returns early.
  await t.test('token file is written privately and removed with its directory on early return', () => {
    const pyScript = `
import sys, os, sqlite3, tempfile, stat, glob, shutil
tempfile.tempdir = tempfile.mkdtemp()
os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

db_fd, db_path = tempfile.mkstemp(suffix='.db')
os.close(db_fd)
conn = sqlite3.connect(db_path)
conn.execute("CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, username TEXT, password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER)")
conn.execute("CREATE TABLE msgraph_accounts (id INTEGER PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT, target_calendar_id TEXT, created_at INTEGER, updated_at INTEGER)")
conn.execute("CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, calendar_id TEXT, owner_user_id TEXT, deleted_by TEXT, href TEXT, ics TEXT, created_at INTEGER)")
enc, iv = sync_worker.encrypt("secret_refresh_token_196", sync_worker.KEY_BYTES)
conn.execute("INSERT INTO linked_accounts (user_id, url, username, password_encrypted, iv, auth_type, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ("testuser196b", "http://127.0.0.1:59999/caldav/v2/user/user", "testuser@example.com", enc, iv, "oauth2", sync_worker.encrypt_token("fake_access_token", sync_worker.KEY_BYTES), 10000000000000))
conn.commit()
conn.close()
os.environ["DATABASE_PATH"] = db_path
os.environ["STATUS_ROOT"] = tempfile.mkdtemp()

seen = []
def failing_discovery(url, token):
    for p in glob.glob(os.path.join(tempfile.gettempdir(), "*", "google_token_*.json")):
        with open(p) as f:
            if "secret_refresh_token_196" in f.read():
                seen.append((p, stat.S_IMODE(os.stat(p).st_mode), stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode)))
    raise RuntimeError("discovery failed")
sync_worker.discover_google_collections = failing_discovery

try:
    success, err_msg = sync_worker.sync_user("testuser196b")
    assert not success, "sync_user must return False when collection discovery fails"
    assert len(seen) == 1, f"expected exactly one private token file, saw {seen}"
    token_path, file_mode, dir_mode = seen[0]
    assert file_mode == 0o600, oct(file_mode)
    assert dir_mode == 0o700, oct(dir_mode)
    assert not os.path.exists(os.path.dirname(token_path)), "private token dir must be removed"
    print("private_token_ok")
finally:
    shutil.rmtree(tempfile.tempdir)
`;
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('private_token_ok'));
  });
});
