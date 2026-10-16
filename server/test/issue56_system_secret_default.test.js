const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { bootProductionServer, TERMINAL, SYSTEM_SYNC_SECRET } = require('./helpers/productionServer');

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

// The server signs in to the internal Radicale as the user with SYSTEM_SYNC_SECRET, both for the
// signed-in session (server/index.js) and for an anonymous public share (resolveShareAccount in
// routes/calendars.js). In production the secret is mandatory (#82), so the observable promise is
// that every such request carries exactly the configured secret, never a built-in one.
test('production server authenticates to the internal Radicale with the configured SYSTEM_SYNC_SECRET only', async (t) => {
  const requests = [];
  const radicale = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"/>');
    });
  });
  await new Promise((resolve) => radicale.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => radicale.close(resolve)));

  const { base, stderr } = await bootProductionServer(t, { INTERNAL_CALDAV_URL: `http://127.0.0.1:${radicale.address().port}` });
  const expected = 'Basic ' + Buffer.from(`testuser:${SYSTEM_SYNC_SECRET}`).toString('base64');
  const assertAllSignedWithSecret = (label) => {
    assert.ok(requests.length > 0, `${label} must reach the internal Radicale; stderr: ${stderr()}`);
    for (const r of requests) assert.equal(r.authorization, expected, `${label}: ${r.method} ${r.url}`);
    requests.length = 0;
  };

  const session = await fetch(`${base}/api/auth/session`, { headers: TERMINAL });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  await fetch(`${base}/api/calendars`, { headers: { ...TERMINAL, cookie } });
  assertAllSignedWithSecret('the session calendar list');

  const calendarId = encodeURIComponent('internal-caldav::/testuser/personal/');
  const link = await fetch(`${base}/api/calendars/${calendarId}/public-link`, {
    method: 'POST',
    headers: { ...TERMINAL, cookie, Origin: 'https://calendar.shard.example', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(link.status, 200, await link.clone().text());
  const token = new URL((await link.json()).url).pathname.split('/').pop();
  requests.length = 0;

  await fetch(`${base}/api/public/calendars/share/${token}`, {
    headers: { 'X-Freeshard-Secret': TERMINAL['X-Freeshard-Secret'], 'X-Ptl-Client-Type': 'anonymous' },
  });
  assertAllSignedWithSecret('the anonymous public share');
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
