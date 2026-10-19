'use strict';

/**
 * Issue #490 — the OIDC token endpoint client authentication method is chosen explicitly, and a
 * failed code exchange logs the provider's error / error_description.
 *
 * The real server app runs (NODE_ENV=production) against a stub IdP whose token endpoint behaves like
 * Authelia: the client is registered for exactly one method (client_secret_basic or client_secret_post)
 * and any other way of presenting the secret is answered with `invalid_client`.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue490-oidc-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'webcalendar';
const CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';
const INVALID_CLIENT_DESCRIPTION = 'Client authentication failed (testuser-provider-detail)';

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

// `registered` is the method the client is registered for at the IdP; `advertised` is what the
// discovery document lists in token_endpoint_auth_methods_supported.
async function startStubIdp() {
  const { SignJWT, generateKeyPair, exportJWK } = await import('jose');
  const tls = createTestCertificate();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const state = { registered: 'client_secret_basic', advertised: ['client_secret_basic', 'client_secret_post'] };
  let issuer;

  function clientAuthenticated(req, form) {
    const header = req.headers.authorization || '';
    if (state.registered === 'client_secret_basic') {
      if (form.has('client_secret') || !header.startsWith('Basic ')) return false;
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      return id === CLIENT_ID && secret === CLIENT_SECRET;
    }
    if (header) return false;
    return form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET;
  }

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
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: state.advertised
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (!clientAuthenticated(req, form)) {
        return json(401, { error: 'invalid_client', error_description: INVALID_CLIENT_DESCRIPTION });
      }
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!grant) return json(400, { error: 'invalid_grant' });
      const derived = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (derived !== grant.challenge) return json(400, { error: 'invalid_grant' });
      const idToken = await new SignJWT({ nonce: grant.nonce, email: 'testuser@example.com', preferred_username: 'testuser' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(CLIENT_ID)
        .setSubject('testuser-sub')
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
    state,
    issueCode({ challenge, nonce }) {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { challenge, nonce });
      return code;
    }
  };
}

test('Issue #490 — OIDC token endpoint auth method and provider error logging', async (t) => {
  const idp = await startStubIdp();
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
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue490.db');
  process.env.SESSION_SECRET = 'issue490-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = idp.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  delete process.env.OIDC_TOKEN_AUTH_METHOD;
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.HTTP_HEADER_AUTH_SECRET;

  const { app, validateSecurityConfig } = require('../index.js');
  const { resetOidcClient } = require('../utils/oidcClient');
  trustTestCertificate(idp.cert);
  server = http.createServer(app);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;

  function cookieFrom(res) {
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || null;
  }

  // Runs one full login against the stub IdP configured as given; returns the callback response
  // and everything the server wrote to console.error during the callback.
  // `reregistered` switches the client's method at the IdP after the app has configured its client
  // (#600 checks the method then), so the code exchange is the first request to see it.
  async function login({ registered, advertised, override, reregistered }) {
    idp.state.registered = registered;
    idp.state.advertised = advertised;
    if (override) process.env.OIDC_TOKEN_AUTH_METHOD = override;
    else delete process.env.OIDC_TOKEN_AUTH_METHOD;
    resetOidcClient();

    const start = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302, `login must redirect, got ${start.status}: ${await start.text()}`);
    if (reregistered) idp.state.registered = reregistered;
    const location = new URL(start.headers.get('location'));
    const code = idp.issueCode({
      challenge: location.searchParams.get('code_challenge'),
      nonce: location.searchParams.get('nonce')
    });

    const logged = [];
    const origError = console.error;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    let cb;
    let body;
    try {
      cb = await fetch(
        `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
        { headers: { cookie: cookieFrom(start) }, redirect: 'manual' }
      );
      body = await cb.text();
    } finally {
      console.error = origError;
    }
    return { status: cb.status, body, log: logged.join('\n') };
  }

  await t.test('a client registered for client_secret_basic logs in (basic chosen from discovery)', async () => {
    const r = await login({ registered: 'client_secret_basic', advertised: ['client_secret_post', 'client_secret_basic'] });
    assert.equal(r.status, 302, `callback must succeed, got ${r.status}: ${r.body} / ${r.log}`);
  });

  await t.test('a client registered for client_secret_post logs in when the IdP offers only post', async () => {
    const r = await login({ registered: 'client_secret_post', advertised: ['client_secret_post'] });
    assert.equal(r.status, 302, `callback must succeed, got ${r.status}: ${r.body} / ${r.log}`);
  });

  await t.test('OIDC_TOKEN_AUTH_METHOD=client_secret_basic overrides the discovery choice', async () => {
    const r = await login({ registered: 'client_secret_basic', advertised: ['client_secret_post'], override: 'client_secret_basic' });
    assert.equal(r.status, 302, `callback must succeed, got ${r.status}: ${r.body} / ${r.log}`);
  });

  await t.test('OIDC_TOKEN_AUTH_METHOD=client_secret_post overrides the discovery choice', async () => {
    const r = await login({ registered: 'client_secret_post', advertised: ['client_secret_basic', 'client_secret_post'], override: 'client_secret_post' });
    assert.equal(r.status, 302, `callback must succeed, got ${r.status}: ${r.body} / ${r.log}`);
  });

  await t.test('a failed exchange logs the provider error and error_description; the browser gets no provider text', async () => {
    const r = await login({
      registered: 'client_secret_post', advertised: ['client_secret_basic', 'client_secret_post'],
      override: 'client_secret_post', reregistered: 'client_secret_basic'
    });
    assert.equal(r.status, 400);
    assert.match(r.log, /invalid_client/);
    assert.ok(r.log.includes(INVALID_CLIENT_DESCRIPTION), `log must carry error_description, got: ${r.log}`);
    assert.doesNotMatch(r.body, /invalid_client/);
    assert.ok(!r.body.includes('testuser-provider-detail'), `response must not reflect provider text, got: ${r.body}`);
  });

  await t.test('provider error text from the callback URL cannot forge or flood log lines', async () => {
    idp.state.registered = 'client_secret_basic';
    delete process.env.OIDC_TOKEN_AUTH_METHOD;
    resetOidcClient();
    const start = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const forged = '\n[OIDC callback] Authentifiziert: testuser (testuser-sub)\r\n' + 'A'.repeat(5000);
    const logged = [];
    const origError = console.error;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    let cb;
    let body;
    try {
      cb = await fetch(
        `${origin}/api/auth/callback?state=${state}&error=access_denied%0Aforged&error_description=${encodeURIComponent(forged)}`,
        { headers: { cookie: cookieFrom(start) }, redirect: 'manual' }
      );
      body = await cb.text();
    } finally {
      console.error = origError;
    }
    assert.equal(cb.status, 400);
    const log = logged.join('\n');
    assert.match(log, /access_denied/, `log must carry the provider error, got: ${log}`);
    for (const entry of logged) {
      assert.ok(!/[\r\n]/.test(entry), `a log entry must stay on one line, got: ${JSON.stringify(entry)}`);
      assert.ok(entry.length < 1000, `a log entry must be bounded, got ${entry.length} chars`);
    }
    assert.ok(!body.includes('Authentifiziert: testuser'), `response must not reflect provider text, got: ${body}`);
  });

  await t.test('an unknown OIDC_TOKEN_AUTH_METHOD stops the start', () => {
    const env = {
      NODE_ENV: 'production', AUTH_METHOD: 'oidc', BASE_URL,
      OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET
    };
    assert.doesNotThrow(() => validateSecurityConfig({ ...env, OIDC_TOKEN_AUTH_METHOD: 'client_secret_basic' }));
    assert.doesNotThrow(() => validateSecurityConfig({ ...env, OIDC_TOKEN_AUTH_METHOD: 'client_secret_post' }));
    assert.throws(() => validateSecurityConfig({ ...env, OIDC_TOKEN_AUTH_METHOD: 'private_key_jwt' }), /OIDC_TOKEN_AUTH_METHOD/);
  });
});
