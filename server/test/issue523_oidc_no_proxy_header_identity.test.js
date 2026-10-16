'use strict';

/**
 * Issue #523 — in AUTH_METHOD=oidc the identity comes from the OIDC callback only. The proxy
 * secret plus X-Forwarded-User / X-User-Id / Remote-User must neither create a session identity
 * nor replace the subject of an OIDC login. The header identity remains only for
 * AUTH_METHOD=env with HTTP_HEADER_AUTH=true, and there a change of identity regenerates the session.
 *
 * Runs the real server app under NODE_ENV=production against a mock IdP.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createTestCertificate, trustTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue523-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'webcalendar';
const HEADER_SECRET = 'issue523-header-auth-secret-0123456789abcdef';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function startMockIdp() {
  const { SignJWT, generateKeyPair, exportJWK } = await import('jose');
  const tls = createTestCertificate();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let issuer;
  const server = https.createServer(tls, async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!grant) return json(400, { error: 'invalid_grant' });
      const idToken = await new SignJWT({ nonce: grant.nonce, email: 'testuser@example.com', preferred_username: 'testuser' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(CLIENT_ID)
        .setSubject(grant.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { id_token: idToken, access_token: 'testuser-access-token', token_type: 'Bearer', expires_in: 300 });
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  issuer = `https://127.0.0.1:${port}`;
  return {
    server,
    issuer,
    cert: tls.cert,
    issueCode(nonce, sub) {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { nonce, sub });
      return code;
    }
  };
}

test('Issue #523 — OIDC mode ignores the proxy header identity (NODE_ENV=production)', async (t) => {
  const idp = await startMockIdp();
  const origEnv = { ...process.env };
  let server = null;
  t.after(() => {
    if (server) server.close();
    idp.server.close();
    process.env = origEnv;
  });
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'oidc';
  process.env.BASE_URL = BASE_URL;
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue523.db');
  process.env.SESSION_SECRET = 'issue523-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = idp.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';
  process.env.HTTP_HEADER_AUTH_SECRET = HEADER_SECRET;
  process.env.SYSTEM_SYNC_SECRET = 'issue523-system-sync-secret-0123456789abcdef';
  process.env.DISABLE_INTERNAL_CALDAV = 'true';
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.CALDAVURL;

  const { app } = require('../index.js');
  trustTestCertificate(idp.cert);
  server = http.createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;

  const cookieFrom = (res) =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || null;

  const session = (headers) => fetch(`${origin}/api/auth/session`, { headers });

  async function oidcLogin(sub) {
    const start = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    const cookie = cookieFrom(start);
    const code = idp.issueCode(location.searchParams.get('nonce'), sub);
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    assert.equal(cb.status, 302, 'OIDC login succeeds');
    return cookieFrom(cb) || cookie;
  }

  for (const httpHeaderAuth of [undefined, 'true']) {
    for (const header of ['x-forwarded-user', 'x-user-id', 'remote-user']) {
      await t.test(`secret + ${header} without OIDC login is 401 (HTTP_HEADER_AUTH=${httpHeaderAuth})`, async () => {
        if (httpHeaderAuth) process.env.HTTP_HEADER_AUTH = httpHeaderAuth; else delete process.env.HTTP_HEADER_AUTH;
        const res = await session({ 'x-freeshard-secret': HEADER_SECRET, [header]: 'owner-sub' });
        assert.equal(res.status, 401, 'the proxy header must not authenticate in oidc mode');
        const cookie = cookieFrom(res);
        if (cookie) {
          const again = await session({ cookie });
          assert.equal(again.status, 401, 'the session must not hold the header identity');
        }
        const accounts = await fetch(`${origin}/api/accounts`, {
          headers: { 'x-freeshard-secret': HEADER_SECRET, [header]: 'owner-sub' }
        });
        assert.equal(accounts.status, 401, 'protected routes must not open with the header identity');
      });
    }
  }

  await t.test('the proxy header cannot replace the subject of an OIDC login', async () => {
    process.env.HTTP_HEADER_AUTH = 'true';
    const cookie = await oidcLogin('testuser-sub');
    const hijack = await session({ cookie, 'x-freeshard-secret': HEADER_SECRET, 'x-forwarded-user': 'owner-sub' });
    assert.equal(hijack.status, 200);
    assert.equal((await hijack.json()).userId, 'testuser-sub', 'the session keeps the OIDC subject');
    const after = await session({ cookie });
    assert.equal((await after.json()).userId, 'testuser-sub', 'the stored session still holds the OIDC subject');
  });

  await t.test('env mode with HTTP_HEADER_AUTH=true regenerates the session when the header identity changes', async () => {
    process.env.AUTH_METHOD = 'env';
    process.env.HTTP_HEADER_AUTH = 'true';
    const proxy = { 'x-freeshard-secret': HEADER_SECRET, 'x-ptl-client-type': 'terminal' };

    const first = await session({ ...proxy, 'x-forwarded-user': 'testuser-a' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).userId, 'testuser-a');
    const cookieA = cookieFrom(first);
    assert.ok(cookieA, 'a session cookie is issued');

    const same = await session({ ...proxy, cookie: cookieA, 'x-forwarded-user': 'testuser-a' });
    assert.equal(same.status, 200);
    const sameCookie = cookieFrom(same);
    assert.ok(!sameCookie || sameCookie === cookieA, 'an unchanged identity keeps its session');

    const second = await session({ ...proxy, cookie: cookieA, 'x-forwarded-user': 'testuser-b' });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).userId, 'testuser-b');
    const cookieB = cookieFrom(second);
    assert.ok(cookieB && cookieB !== cookieA, 'a new identity gets a new session id');

    const stale = await session({ ...proxy, cookie: cookieA });
    assert.equal(stale.status, 401, 'the old session id no longer carries any identity');
  });

  await t.test('env mode without HTTP_HEADER_AUTH=true ignores the header identity', async () => {
    process.env.AUTH_METHOD = 'env';
    delete process.env.HTTP_HEADER_AUTH;
    const res = await session({ 'x-freeshard-secret': HEADER_SECRET, 'x-ptl-client-type': 'terminal', 'x-forwarded-user': 'owner-sub' });
    assert.notEqual(res.status === 200 && (await res.json()).userId, 'owner-sub');
  });

  await t.test('env mode: a pre-existing anonymous session is not kept when the header identity arrives', async () => {
    process.env.AUTH_METHOD = 'env';
    process.env.HTTP_HEADER_AUTH = 'true';
    const proxy = { 'x-freeshard-secret': HEADER_SECRET, 'x-ptl-client-type': 'terminal' };

    // A session without identity, carrying data planted before the login.
    const planted = await session({ ...proxy, 'x-forwarded-email': 'planted@example.com' });
    assert.equal(planted.status, 401);
    const anonCookie = cookieFrom(planted);
    assert.ok(anonCookie, 'the anonymous session is stored');

    const login = await session({ ...proxy, cookie: anonCookie, 'x-forwarded-user': 'testuser-c' });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.equal(body.userId, 'testuser-c');
    assert.notEqual(body.email, 'planted@example.com', 'data of the anonymous session is not inherited');
    const loginCookie = cookieFrom(login);
    assert.ok(loginCookie && loginCookie !== anonCookie, 'the identity gets a new session id');
  });
});

function bootServer(env) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.includes('running on')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ started: stdout.includes('running on'), code, stderr });
    });
  });
}

test('Issue #523 — AUTH_METHOD=oidc with HTTP_HEADER_AUTH=true refuses to start (NODE_ENV=production)', async () => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    PORT: '0',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, 'issue523-boot.db'),
    SESSION_SECRET: 'issue523-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue523-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue523-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: HEADER_SECRET,
    BASE_URL: BASE_URL,
    AUTH_METHOD: 'oidc',
    OIDC_ISSUER_URL: 'https://issuer.example.com',
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'testuser-client-secret-0123456789abcdef',
    HTTP_HEADER_AUTH: 'true'
  };
  const r = await bootServer(env);
  assert.equal(r.started, false, 'the server must not start');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP_HEADER_AUTH=true is only valid with AUTH_METHOD=env/);
});
