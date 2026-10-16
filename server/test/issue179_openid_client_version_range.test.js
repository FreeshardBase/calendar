'use strict';

/**
 * Issue #179 — the OIDC wiring runs on openid-client v6 (the only line upstream still patches).
 *
 * Runs the real server app under NODE_ENV=production against a mock https identity provider and
 * drives getOidcClient() through every path that uses it: login, callback with UserInfo, and
 * back-channel logout with the JWKS discovered from the issuer. The v6 safeguards that v5 lacked
 * are pinned as behaviour: a plain-http issuer is refused before any request leaves the app, and a
 * UserInfo response about a different subject is not taken for the signed-in user.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue179-oidc-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'webcalendar';
const CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';

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

// The ID token carries only sub and nonce, so the app has to ask UserInfo for name and email.
async function startMockIdp({ secure }) {
  const { SignJWT, generateKeyPair, exportJWK } = await import('jose');
  const tls = createTestCertificate();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const accessTokens = new Map();
  const requests = [];
  let issuer;

  const sign = (claims) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('5m');

  const handler = async (req, res) => {
    requests.push(req.url);
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
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        backchannel_logout_supported: true
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!grant) return json(400, { error: 'invalid_grant' });
      const derived = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (derived !== grant.challenge || form.get('redirect_uri') !== grant.redirectUri) {
        return json(400, { error: 'invalid_grant' });
      }
      const accessToken = crypto.randomBytes(16).toString('hex');
      accessTokens.set(accessToken, grant.userinfo);
      const idToken = await sign({ nonce: grant.nonce }).setSubject(grant.sub).sign(privateKey);
      return json(200, { id_token: idToken, access_token: accessToken, token_type: 'Bearer', expires_in: 300 });
    }
    if (url.pathname === '/userinfo') {
      const userinfo = accessTokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!userinfo) return json(401, { error: 'invalid_token' });
      return json(200, userinfo);
    }
    res.writeHead(404);
    res.end();
  };

  const server = secure ? https.createServer(tls, handler) : http.createServer(handler);
  const port = await listen(server);
  issuer = `${secure ? 'https' : 'http'}://127.0.0.1:${port}`;
  return {
    server,
    issuer,
    cert: tls.cert,
    requests,
    issueCode(location, sub, userinfo) {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: location.searchParams.get('code_challenge'),
        nonce: location.searchParams.get('nonce'),
        redirectUri: location.searchParams.get('redirect_uri'),
        sub,
        userinfo
      });
      return code;
    },
    logoutToken(sub) {
      return sign({ events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, jti: crypto.randomUUID() })
        .setSubject(sub)
        .sign(privateKey);
    }
  };
}

test('Issue #179 — OIDC on openid-client v6 (NODE_ENV=production)', async (t) => {
  const idp = await startMockIdp({ secure: true });
  const plainIdp = await startMockIdp({ secure: false });
  const origEnv = { ...process.env };
  let server = null;
  // Registered before the app loads: if loading it throws, the mock IdPs must not keep the process alive.
  t.after(() => {
    if (server) server.close();
    idp.server.close();
    plainIdp.server.close();
    process.env = origEnv;
  });
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'oidc';
  process.env.BASE_URL = BASE_URL;
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue179.db');
  process.env.SESSION_SECRET = 'issue179-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.HTTP_HEADER_AUTH_SECRET;

  const { app } = require('../index.js');
  const { resetOidcClient } = require('../utils/oidcClient');
  // After the app: server/index.js installs its own global dispatcher on load.
  trustTestCertificate(idp.cert);
  t.after(() => resetOidcClient());
  server = http.createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;

  const cookieFrom = (res) =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || null;

  async function sessionStatus(cookie) {
    const res = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    return { status: res.status, body: await res.json() };
  }

  async function login(sub, userinfo) {
    const start = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302, `login must redirect to the IdP, got ${start.status}: ${await start.text()}`);
    const location = new URL(start.headers.get('location'));
    assert.equal(location.origin + location.pathname, `${idp.issuer}/authorize`);
    const code = idp.issueCode(location, sub, userinfo);
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieFrom(start) }, redirect: 'manual' }
    );
    assert.equal(cb.status, 302, `callback must succeed, got ${cb.status}: ${await cb.text()}`);
    return cookieFrom(cb);
  }

  await t.test('a plain-http issuer is refused before any request reaches it', async () => {
    resetOidcClient();
    process.env.OIDC_ISSUER_URL = plainIdp.issuer;
    const res = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 500, 'login against an http issuer must fail');
    assert.match(await res.text(), /HTTPS/i);
    assert.deepEqual(plainIdp.requests, [], 'no discovery request may go out over plain http');
  });

  await t.test('login and callback against an https issuer take name and email from UserInfo', async () => {
    resetOidcClient();
    process.env.OIDC_ISSUER_URL = idp.issuer;
    const cookie = await login('testuser-sub', {
      sub: 'testuser-sub', preferred_username: 'testuser', email: 'testuser@example.com'
    });
    const { status, body } = await sessionStatus(cookie);
    assert.equal(status, 200);
    assert.equal(body.userId, 'testuser-sub');
    assert.equal(body.username, 'testuser');
    assert.equal(body.email, 'testuser@example.com');
  });

  await t.test('a UserInfo response about another subject is not used for the signed-in user', async () => {
    const cookie = await login('testuser-sub2', {
      sub: 'someone-else', preferred_username: 'impostor', email: 'impostor@example.com'
    });
    const { status, body } = await sessionStatus(cookie);
    assert.equal(status, 200);
    assert.equal(body.userId, 'testuser-sub2');
    assert.notEqual(body.username, 'impostor');
    assert.notEqual(body.email, 'impostor@example.com');
  });

  await t.test('back-channel logout verifies the token with the JWKS discovered from the issuer', async () => {
    const cookie = await login('testuser-sub3', { sub: 'testuser-sub3', preferred_username: 'testuser3' });
    assert.equal((await sessionStatus(cookie)).status, 200);
    const res = await fetch(`${origin}/api/auth/backchannel-logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: await idp.logoutToken('testuser-sub3') })
    });
    assert.equal(res.status, 200, `back-channel logout must succeed, got ${res.status}: ${await res.text()}`);
    assert.equal((await sessionStatus(cookie)).status, 401, 'the session must be ended by the IdP');
  });
});
