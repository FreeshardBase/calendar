'use strict';

/**
 * Issue #340 — OIDC login and logout hardening, under NODE_ENV=production semantics.
 *
 * The real server app runs against a mock identity provider that behaves like a strict IdP:
 * an authorization code issued for a PKCE challenge is only redeemed with the matching
 * code_verifier, and the id_token carries the nonce of the authorization request it answers.
 *
 *  - The login redirect carries an S256 PKCE challenge, a nonce and a state.
 *  - The callback refuses a missing state (login CSRF) and an id_token with a foreign nonce.
 *  - A successful login issues a new session id; the pre-login id stays anonymous (fixation).
 *  - GET /logout no longer logs out; POST /logout does, and only from the app's own origin.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue340-oidc-'));
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

// A strict mock IdP: codes are bound to the PKCE challenge and nonce they were issued for.
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
        userinfo_endpoint: `${issuer}/userinfo`,
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
      if (grant.redirectUri && form.get('redirect_uri') !== grant.redirectUri) {
        return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      if (grant.challenge) {
        const verifier = form.get('code_verifier');
        const derived = verifier && crypto.createHash('sha256').update(verifier).digest('base64url');
        if (grant.challengeMethod !== 'S256' || derived !== grant.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }
      const claims = { email: 'testuser@example.com', preferred_username: 'testuser' };
      if (grant.nonce) claims.nonce = grant.nonce;
      const idToken = await new SignJWT(claims)
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
    issueCode({ challenge, challengeMethod, nonce, redirectUri, sub = 'testuser-sub' }) {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { challenge, challengeMethod, nonce, redirectUri, sub });
      return code;
    }
  };
}

test('Issue #340 — OIDC login & logout hardening (NODE_ENV=production)', async (t) => {
  const idp = await startMockIdp();
  const origEnv = { ...process.env };
  let server = null;
  // Registered before the app loads: if loading it throws, the mock IdP must not keep the process alive.
  t.after(() => {
    if (server) server.close();
    idp.server.close();
    process.env = origEnv;
  });
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'oidc';
  process.env.BASE_URL = BASE_URL;
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue340.db');
  process.env.SESSION_SECRET = 'issue340-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = idp.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  // Ignored since #340 (redirect URIs come from BASE_URL); set to a stale value so the pre-fix code is
  // fully configured and a regression to the env variables is visible.
  process.env.OIDC_REDIRECT_URI = 'https://stale.example/api/auth/callback';
  process.env.GOOGLE_CLIENT_ID = 'testuser-google-client';
  process.env.GOOGLE_REDIRECT_URI = 'https://stale.example/api/auth/google/callback';
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.HTTP_HEADER_AUTH_SECRET;

  const { app } = require('../index.js');
  // After the app: server/index.js installs its own global dispatcher on load.
  trustTestCertificate(idp.cert);
  const { loginAs } = require('./helpers/testSession');
  server = http.createServer(app);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;

  function cookieFrom(res) {
    const raw = res.headers.getSetCookie();
    const sid = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
    return sid || null;
  }

  async function sessionStatus(cookie) {
    const res = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    return { status: res.status, body: await res.json() };
  }

  // The forged host must never reach a redirect URI.
  const FORGED = { 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' };

  async function startLogin() {
    const res = await fetch(`${origin}/api/auth/login`, { headers: FORGED, redirect: 'manual' });
    assert.equal(res.status, 302, 'login must redirect to the identity provider');
    const location = new URL(res.headers.get('location'));
    const cookie = cookieFrom(res);
    assert.ok(cookie, 'login must start a session that holds the login transaction');
    return { location, cookie };
  }

  await t.test('login redirect carries an S256 PKCE challenge, a nonce, a state and the BASE_URL redirect_uri', async () => {
    const { location } = await startLogin();
    assert.equal(location.origin + location.pathname, `${idp.issuer}/authorize`);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.match(location.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/);
    assert.ok((location.searchParams.get('nonce') || '').length >= 32, 'nonce must be present and unguessable');
    assert.ok((location.searchParams.get('state') || '').length >= 32, 'state must be present and unguessable');
    assert.equal(location.searchParams.get('redirect_uri'), `${BASE_URL}/api/auth/callback`);
  });

  await t.test('successful login regenerates the session id; the pre-login id stays anonymous', async () => {
    const { location, cookie: preLogin } = await startLogin();
    const code = idp.issueCode({
      challenge: location.searchParams.get('code_challenge'),
      challengeMethod: location.searchParams.get('code_challenge_method'),
      nonce: location.searchParams.get('nonce'),
      redirectUri: location.searchParams.get('redirect_uri')
    });
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie: preLogin, ...FORGED }, redirect: 'manual' }
    );
    assert.equal(cb.status, 302, `callback must succeed, got ${cb.status}: ${await cb.text()}`);
    const postLogin = cookieFrom(cb);
    assert.ok(postLogin, 'callback must issue a fresh session cookie');
    assert.notEqual(postLogin, preLogin, 'session id must change on login');

    const fresh = await sessionStatus(postLogin);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.userId, 'testuser-sub');

    const fixated = await sessionStatus(preLogin);
    assert.equal(fixated.status, 401, 'the pre-login session id (attacker-fixated) must not be logged in');
  });

  await t.test('a code redeemed without the PKCE verifier of this login is refused by the IdP', async () => {
    const { location, cookie } = await startLogin();
    // The code was issued for a different challenge (e.g. an intercepted code from another login).
    const code = idp.issueCode({
      challenge: crypto.createHash('sha256').update('attacker-verifier').digest('base64url'),
      challengeMethod: 'S256',
      nonce: location.searchParams.get('nonce')
    });
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    assert.equal(cb.status, 400);
    assert.equal((await sessionStatus(cookieFrom(cb) || cookie)).status, 401);
  });

  await t.test('an id_token with a foreign nonce is refused', async () => {
    const { location, cookie } = await startLogin();
    const code = idp.issueCode({
      challenge: location.searchParams.get('code_challenge'),
      challengeMethod: 'S256',
      nonce: 'replayed-nonce-from-another-login-0123456789'
    });
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    assert.equal(cb.status, 400);
    assert.equal((await sessionStatus(cookieFrom(cb) || cookie)).status, 401);
  });

  await t.test('an id_token without the nonce of this login is refused', async () => {
    const { location, cookie } = await startLogin();
    const code = idp.issueCode({
      challenge: location.searchParams.get('code_challenge'),
      challengeMethod: 'S256'
    });
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    assert.equal(cb.status, 400);
    assert.match(await cb.text(), /nonce/);
    assert.equal((await sessionStatus(cookieFrom(cb) || cookie)).status, 401);
  });

  await t.test('the Google OAuth redirect_uri comes from BASE_URL, not from the request', async () => {
    const cookie = await loginAs('testuser');
    const res = await fetch(`${origin}/api/auth/google`, { headers: { cookie, ...FORGED }, redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('redirect_uri'), `${BASE_URL}/api/auth/google/callback`);
  });

  await t.test('a callback without state (no login transaction) is refused — no login CSRF', async () => {
    // Attacker plants their own code into the victim's browser; neither side carries a state.
    const code = idp.issueCode({ sub: 'attacker-sub' });
    const cb = await fetch(`${origin}/api/auth/callback?code=${code}`, { redirect: 'manual' });
    assert.equal(cb.status, 400);
    assert.match(await cb.text(), /keine laufende Anmeldung/);
    const cookie = cookieFrom(cb);
    if (cookie) assert.equal((await sessionStatus(cookie)).status, 401);
  });

  await t.test('GET /api/auth/logout no longer logs out (no logout CSRF via <img>)', async () => {
    const cookie = await loginAs('testuser');
    await fetch(`${origin}/api/auth/logout`, { headers: { cookie }, redirect: 'manual' });
    assert.equal((await sessionStatus(cookie)).status, 200, 'session must survive a GET to /logout');
  });

  await t.test('POST /api/auth/logout from a sibling app on the shard is refused', async () => {
    const cookie = await loginAs('testuser');
    const res = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, Origin: 'https://evil.shard.example' },
      redirect: 'manual'
    });
    assert.equal(res.status, 403);
    assert.equal((await sessionStatus(cookie)).status, 200);
  });

  await t.test('POST /api/auth/logout from the app itself ends the session', async () => {
    const cookie = await loginAs('testuser');
    const res = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, Origin: BASE_URL },
      redirect: 'manual'
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    assert.equal((await sessionStatus(cookie)).status, 401, 'session must be destroyed server-side');
  });
});
