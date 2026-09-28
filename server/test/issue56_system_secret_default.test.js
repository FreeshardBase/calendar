const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('No hardcoded super-secret-bypass in docker-compose.yml', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
  assert.ok(!content.includes('freeshard-default-encryption-key-do-not-use-in-prod'), 'Should not contain default encryption key');
});

test('No hardcoded super-secret-bypass in radicale custom auth', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../radicale/radicale_custom_auth.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in sync-worker msgraph_worker.py', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../sync-worker/msgraph_worker.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in sync-worker sync_worker.py', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../sync-worker/sync_worker.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in server routes', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.ok(!index.includes('super-secret-bypass'), 'index.js should not contain super-secret-bypass');
  
  const calendars = fs.readFileSync(path.join(__dirname, '../routes/calendars.js'), 'utf8');
  assert.ok(!calendars.includes('super-secret-bypass'), 'calendars.js should not contain super-secret-bypass');
});

test('docker-compose.yml supplies no default :- fallbacks for SYSTEM_SYNC_SECRET and ENCRYPTION_KEY', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
  assert.ok(!content.includes('SYSTEM_SYNC_SECRET:-'), 'docker-compose.yml must not use default fallback :- for SYSTEM_SYNC_SECRET');
  assert.ok(!content.includes('freeshard-default-encryption-key-do-not-use-in-prod'), 'docker-compose.yml must not supply default encryption key');
});

test("Clayde's finding: radicale_custom_auth with unset SYSTEM_SYNC_SECRET rejects super-secret-bypass", () => {
  const pyScript = `
import os, sys, tempfile, sqlite3, types

m_radicale = types.ModuleType('radicale')
m_auth = types.ModuleType('radicale.auth')
class BaseAuth:
    def __init__(self, configuration):
        self.configuration = configuration
m_auth.BaseAuth = BaseAuth
sys.modules['radicale'] = m_radicale
sys.modules['radicale.auth'] = m_auth

radicale_dir = os.path.abspath('${path.join(__dirname, '../../radicale')}')
if radicale_dir not in sys.path:
    sys.path.insert(0, radicale_dir)

import radicale_custom_auth

tmp_dir = tempfile.mkdtemp()
db_path = os.path.join(tmp_dir, 'webcalendar.db')
os.environ['DATABASE_PATH'] = db_path
os.environ.pop('SYSTEM_SYNC_SECRET', None)

conn = sqlite3.connect(db_path)
conn.execute('CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL)')
conn.execute('CREATE TABLE app_passwords (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_hash TEXT NOT NULL)')
conn.execute('INSERT INTO users (user_id, username) VALUES (?, ?)', ('uuid-of-victim', 'victim'))
conn.commit()
conn.close()

auth = radicale_custom_auth.Auth({})

# 1. With SYSTEM_SYNC_SECRET unset:
res1 = auth._login('victim', 'super-secret-bypass')
res2 = auth._login('victim', 'wrong-password')

# 2. With SYSTEM_SYNC_SECRET configured:
os.environ['SYSTEM_SYNC_SECRET'] = 'strong-configured-sync-secret'
res3 = auth._login('victim', 'strong-configured-sync-secret')
res4 = auth._login('victim', 'super-secret-bypass')

print(f"{res1}|{res2}|{res3}|{res4}")
`;

  const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    env: { ...process.env, SYSTEM_SYNC_SECRET: '' }
  }).trim();

  const [res1, res2, res3, res4] = output.split('|');
  assert.strictEqual(res1, '', "login with 'super-secret-bypass' when SYSTEM_SYNC_SECRET is unset must return empty string");
  assert.strictEqual(res2, '', "login with 'wrong-password' when SYSTEM_SYNC_SECRET is unset must return empty string");
  assert.strictEqual(res3, 'uuid-of-victim', "login with configured SYSTEM_SYNC_SECRET must return user_id");
  assert.strictEqual(res4, '', "login with 'super-secret-bypass' when SYSTEM_SYNC_SECRET is set to something else must return empty string");
});
