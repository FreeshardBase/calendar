'use strict';

/**
 * Issue #333 — losing .encryption_key must not silently mint a new key.
 *
 * Every scenario boots server/db.js (or server/index.js) in a child process under
 * NODE_ENV=production against a temporary database, the way a shard restarts after
 * a restore or a volume mix-up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encryptForSecret } = require('./helpers/storedCiphertext');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const ROOT_DIR = path.join(__dirname, '../..');
const DB_MODULE = path.join(ROOT_DIR, 'server/db.js');
const INDEX_MODULE = path.join(ROOT_DIR, 'server/index.js');

const KEY_A = 'issue333-original-install-key-0123456789abcdef';
const KEY_B = 'issue333-some-other-install-key-fedcba9876543210';

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue333-'));
}

function baseEnv(dbPath, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    DATABASE_PATH: dbPath,
    ...extra,
  };
}

// Boots db.js, waits for the key gate, optionally runs `script` (with `Db` in scope).
function bootDb(env, script = '') {
  const code = `
    const Db = require(${JSON.stringify(DB_MODULE)});
    Db.ready.then(async () => {
      ${script}
      console.log('READY');
      Db.db.close(() => process.exit(0));
    }, (err) => {
      console.log('REJECTED ' + err.message);
      process.exit(3);
    });
  `;
  return spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 30000 });
}

function legacyEncrypt(secret, plaintext) {
  const { ciphertext, iv } = encryptForSecret(secret, plaintext);
  return { encrypted: ciphertext, iv };
}

// A database written before #333: credentials encrypted with `secret`, no key-check row.
async function createLegacyDb(dbPath, secret) {
  const { encrypted, iv } = legacyEncrypt(secret, 'testuser-caldav-password');
  const db = new sqlite3.Database(dbPath);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
  await run(`CREATE TABLE linked_accounts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL,
    password_encrypted TEXT NOT NULL, iv TEXT NOT NULL, display_name TEXT NOT NULL,
    auth_type TEXT DEFAULT 'basic', access_token TEXT, expires_at INTEGER)`);
  await run('INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['acc-legacy', 'testuser', 'https://caldav.example.com/', 'testuser', encrypted, iv, 'Test User']);
  await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

test.describe('Issue #333 — encryption key canary and fresh-install-only key generation', () => {

  test('fresh install generates a key, then refuses to mint a new one once the key file is lost', () => {
    const tmp = makeTmp();
    const dbPath = path.join(tmp, 'webcalendar.db');
    const keyFile = path.join(tmp, '.encryption_key');
    try {
      const first = bootDb(baseEnv(dbPath), `
        await Db.addAccount('testuser', { url: 'https://caldav.example.com/', username: 'testuser', password: 'testuser-pass', displayName: 'Test User' });
      `);
      assert.equal(first.status, 0, `fresh install must boot: ${first.stdout}${first.stderr}`);
      assert.ok(fs.existsSync(keyFile), 'fresh install must persist the generated key');
      const originalKey = fs.readFileSync(keyFile, 'utf8').trim();

      // Restore that missed the sidecar.
      fs.rmSync(keyFile);
      const second = bootDb(baseEnv(dbPath));
      assert.equal(second.status, 3, `boot without the key must fail: ${second.stdout}${second.stderr}`);
      assert.match(second.stdout, /REJECTED .*encryption key/i);
      assert.equal(fs.existsSync(keyFile), false, 'no replacement key may be written next to existing ciphertexts');

      // Putting the right key back makes the install boot and decrypt again.
      fs.writeFileSync(keyFile, originalKey, { mode: 0o600 });
      const third = bootDb(baseEnv(dbPath), `
        const accounts = await Db.getAccounts('testuser');
        if (accounts.length !== 1 || accounts[0].password !== 'testuser-pass') throw new Error('credentials not decryptable');
      `);
      assert.equal(third.status, 0, `boot with the restored key must succeed: ${third.stdout}${third.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a configured key that cannot decrypt the key-check value aborts startup', () => {
    const tmp = makeTmp();
    const dbPath = path.join(tmp, 'webcalendar.db');
    try {
      const first = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_A }));
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      fs.rmSync(path.join(tmp, '.encryption_key'));

      // Volume mix-up: the database of install A started with install B's key, no rows encrypted yet.
      const wrong = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_B }));
      assert.equal(wrong.status, 3, `${wrong.stdout}${wrong.stderr}`);
      assert.match(wrong.stdout, /REJECTED .*cannot decrypt/i);

      const right = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_A }));
      assert.equal(right.status, 0, `${right.stdout}${right.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('pre-#333 database without key-check: wrong key and missing key are rejected, right key adopts a canary', async () => {
    const tmp = makeTmp();
    const dbPath = path.join(tmp, 'webcalendar.db');
    const keyFile = path.join(tmp, '.encryption_key');
    try {
      await createLegacyDb(dbPath, KEY_A);

      const missing = bootDb(baseEnv(dbPath));
      assert.equal(missing.status, 3, `${missing.stdout}${missing.stderr}`);
      assert.equal(fs.existsSync(keyFile), false, 'no key may be generated for a database with encrypted rows');

      const wrong = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_B }));
      assert.equal(wrong.status, 3, `${wrong.stdout}${wrong.stderr}`);
      fs.rmSync(keyFile, { force: true });

      const right = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_A }), `
        const accounts = await Db.getAccounts('testuser');
        if (accounts[0].password !== 'testuser-caldav-password') throw new Error('legacy row not decryptable');
      `);
      assert.equal(right.status, 0, `${right.stdout}${right.stderr}`);
      fs.rmSync(keyFile, { force: true });

      // Once adopted, the key-check row alone rejects a wrong key, even with no credential rows left.
      const wipe = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_A }), `
        await new Promise((resolve, reject) => Db.db.run('DELETE FROM linked_accounts', (err) => (err ? reject(err) : resolve())));
      `);
      assert.equal(wipe.status, 0, `${wipe.stdout}${wipe.stderr}`);
      fs.rmSync(keyFile, { force: true });
      const wrongAfter = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_B }));
      assert.equal(wrongAfter.status, 3, `${wrongAfter.stdout}${wrongAfter.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('server/index.js exits non-zero instead of serving with a key that cannot decrypt the database', () => {
    const tmp = makeTmp();
    const dbPath = path.join(tmp, 'webcalendar.db');
    try {
      const first = bootDb(baseEnv(dbPath, { ENCRYPTION_KEY: KEY_A }));
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      fs.rmSync(path.join(tmp, '.encryption_key'));

      const result = spawnSync(process.execPath, [INDEX_MODULE], {
        env: baseEnv(dbPath, {
          ENCRYPTION_KEY: KEY_B,
          SESSION_SECRET: 'issue333-session-secret-0123456789abcdef0123',
          SYSTEM_SYNC_SECRET: 'issue333-system-sync-secret-0123456789abcdef',
          INTERNAL_WEBHOOK_SECRET: 'issue333-internal-webhook-secret-0123456789',
          HTTP_HEADER_AUTH_SECRET: 'issue333-proxy-secret-0123456789abcdef0123',
          BASE_URL: 'https://calendar.example.com',
          PORT: '0',
          SSL_KEY_PATH: '',
          SSL_CERT_PATH: '',
          DISABLE_INTERNAL_CALDAV: '1',
        }),
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(result.signal, null, `server kept running with a wrong key: ${result.stdout}${result.stderr}`);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /\[startup\].*cannot decrypt/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('failing to persist the key is fatal, in every environment', () => {
    const tmp = makeTmp();
    try {
      const blocker = path.join(tmp, 'not-a-directory');
      fs.writeFileSync(blocker, '');
      const keyFile = path.join(blocker, '.encryption_key');
      const dbPath = path.join(tmp, 'webcalendar.db');

      // Loaded in a child against its own database, so the module's boot never touches a shared one.
      for (const NODE_ENV of ['production', 'development']) {
        for (const extra of [{}, { ENCRYPTION_KEY: KEY_A }]) {
          const result = bootDb(baseEnv(path.join(tmp, 'boot.db'), { ENCRYPTION_KEY: KEY_A }), `
            try {
              Db.resolveEncryptionKey(${JSON.stringify({ NODE_ENV, ENCRYPTION_KEY_FILE: keyFile, ...extra })}, ${JSON.stringify(dbPath)});
              console.log('NOT THROWN');
            } catch (err) {
              console.log('THROWN ' + err.message);
            }
          `);
          assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
          assert.match(result.stdout, /THROWN .*(EEXIST|ENOTDIR)/, `NODE_ENV=${NODE_ENV}: ${result.stdout}`);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
