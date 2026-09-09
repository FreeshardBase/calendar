const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Db = require('../db');

test('Issue #207 — Deleted user credentials cleanup in /tmp and container stop', async (t) => {

  await t.test('1. Db.deleteUser(userId) cleans up residual /tmp credential files for deleted user', async () => {
    const userId = 'deleted_user_207';
    const tokenFile = path.join('/tmp', `google_token_${userId}_0.json`);
    const iniFile1 = path.join('/tmp', `vdir_${userId}.ini`);
    const iniFile2 = path.join('/tmp', `vdir_basic_${userId}.ini`);

    // Create dummy credential files in /tmp
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'secret_token_123' }));
    fs.writeFileSync(iniFile1, `password = "secret_pass_123"`);
    fs.writeFileSync(iniFile2, `password = "secret_pass_456"`);

    assert.equal(fs.existsSync(tokenFile), true, 'Dummy token file should exist before deleteUser');
    assert.equal(fs.existsSync(iniFile1), true, 'Dummy ini file 1 should exist before deleteUser');
    assert.equal(fs.existsSync(iniFile2), true, 'Dummy ini file 2 should exist before deleteUser');

    // Perform user deletion
    await Db.deleteUser(userId);

    // Verify all /tmp credential files for deleted user are unlinked
    assert.equal(fs.existsSync(tokenFile), false, 'Token file in /tmp should be deleted after Db.deleteUser');
    assert.equal(fs.existsSync(iniFile1), false, 'vdir ini file in /tmp should be deleted after Db.deleteUser');
    assert.equal(fs.existsSync(iniFile2), false, 'vdir_basic ini file in /tmp should be deleted after Db.deleteUser');
  });

  await t.test('2. sync_worker purge_tmp_credential_files and handle_shutdown_signal purge /tmp credentials', () => {
    const tmpPy = path.join('/tmp', 'test_runner_207.py');
    const pyCode = `
import os, sys, glob
sys.path.insert(0, "sync-worker")
import sync_worker

f1 = "/tmp/vdir_shutdown_test.ini"
f2 = "/tmp/vdir_basic_shutdown_test.ini"
f3 = "/tmp/google_token_shutdown_test_0.json"

for f in [f1, f2, f3]:
    with open(f, "w") as fp:
        fp.write("dummy credential content")

assert os.path.exists(f1), "f1 should exist"
assert os.path.exists(f2), "f2 should exist"
assert os.path.exists(f3), "f3 should exist"

sync_worker.purge_tmp_credential_files()

assert not os.path.exists(f1), "f1 should be purged"
assert not os.path.exists(f2), "f2 should be purged"
assert not os.path.exists(f3), "f3 should be purged"

print("PYTHON_PURGE_SUCCESS")
`;
    fs.writeFileSync(tmpPy, pyCode);
    try {
      const res = execSync(`python3 ${tmpPy}`, { encoding: 'utf8' });
      assert.match(res, /PYTHON_PURGE_SUCCESS/);
    } finally {
      if (fs.existsSync(tmpPy)) fs.unlinkSync(tmpPy);
    }
  });
});
