'use strict';

/**
 * Issue #535 — logout must end the identity provider's session too, or the next page load signs
 * the browser straight back in without any interaction at the provider.
 *
 * The real server app runs under NODE_ENV=production against a mock OP that keeps its own browser
 * session (a cookie on the OP's origin): while it lives, /authorize answers without interaction
 * unless prompt=login is requested. A small cookie-jar browser follows every redirect between the
 * app and the OP like a real one.
 *
 *  - An OP with end_session_endpoint: POST /api/auth/logout sends the browser there with the
 *    id_token of this login as id_token_hint and post_logout_redirect_uri = BASE_URL; afterwards
 *    GET / ends at the OP's login form, not in an authenticated session.
 *  - An OP without end_session_endpoint: the next login after a logout requests prompt=login, so
 *    the OP's surviving session cannot sign the browser back in either.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue535-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'webcalendar';
const LOGIN_FORM = 'OP login form';

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

// A mock OP with its own browser session. endSession: whether it offers RP-initiated logout.
async function startMockOp({ endSession }) {
  const { SignJWT, jwtVerify, generateKeyPair, exportJWK } = await import('jose');
  const tls = createTestCertificate();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const opSessions = new Map(); // OP session cookie value -> sub
  const issuedIdTokens = [];
  const endSessionCalls = [];
  const authorizeCalls = [];
  let issuer;

  const opSessionOf = (req) => {
    const m = /(?:^|;\s*)op_session=([^;]+)/.exec(req.headers.cookie || '');
    return m && opSessions.has(m[1]) ? m[1] : null;
  };

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
        ...(endSession ? { end_session_endpoint: `${issuer}/end_session` } : {}),
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      authorizeCalls.push(Object.fromEntries(url.searchParams));
      const issueCode = (sub) => {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, { nonce: url.searchParams.get('nonce'), sub });
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state'));
        return back.href;
      };
      const sid = opSessionOf(req);
      if (sid && url.searchParams.get('prompt') !== 'login') {
        res.writeHead(302, { Location: issueCode(opSessions.get(sid)) });
        return res.end();
      }
      // Interaction: the test "submits" the form by calling op.submitLogin() with this URL.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(LOGIN_FORM);
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const sid = crypto.randomBytes(12).toString('hex');
      opSessions.set(sid, form.get('sub'));
      const authorize = new URL(form.get('return_to'));
      authorize.searchParams.delete('prompt');
      res.writeHead(302, { Location: authorize.href, 'Set-Cookie': `op_session=${sid}; Path=/; HttpOnly` });
      return res.end();
    }
    if (url.pathname === '/end_session') {
      const params = Object.fromEntries(url.searchParams);
      endSessionCalls.push(params);
      const { payload } = await jwtVerify(params.id_token_hint || '', publicKey, { issuer, audience: CLIENT_ID });
      const sid = opSessionOf(req);
      if (sid && opSessions.get(sid) === payload.sub) opSessions.delete(sid);
      res.writeHead(302, { Location: params.post_logout_redirect_uri, 'Set-Cookie': 'op_session=; Path=/; Max-Age=0' });
      return res.end();
    }
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
      issuedIdTokens.push(idToken);
      return json(200, { id_token: idToken, access_token: 'testuser-access-token', token_type: 'Bearer', expires_in: 300 });
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  issuer = `https://127.0.0.1:${port}`;
  return { server, issuer, cert: tls.cert, issuedIdTokens, endSessionCalls, authorizeCalls, opSessions };
}

// A browser with one cookie jar per origin that follows redirects; BASE_URL maps to the local app.
function makeBrowser(appOrigin) {
  const jars = new Map();
  const toReal = (u) => (u.startsWith(BASE_URL) ? appOrigin + u.slice(BASE_URL.length) : u);
  async function request(rawUrl, { method = 'GET', headers = {}, body } = {}) {
    let url = new URL(toReal(rawUrl), appOrigin).href;
    const visited = [];
    for (let hop = 0; hop < 15; hop++) {
      const { origin } = new URL(url);
      const jar = jars.get(origin) || new Map();
      jars.set(origin, jar);
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, { method, body, redirect: 'manual', headers: { ...headers, ...(cookie ? { cookie } : {}) } });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(';');
        const [k, v] = pair.split('=');
        if (v === '' || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(k.trim()); else jar.set(k.trim(), v);
      }
      visited.push({ url, status: res.status });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) {
        return { res, text: await res.text(), url, visited };
      }
      url = new URL(toReal(location), url).href;
      method = 'GET';
      body = undefined;
      headers = {};
    }
    throw new Error('too many redirects');
  }
  const cookie = (name) => (jars.get(appOrigin) || new Map()).get(name);
  return { request, cookie };
}

async function withApp(t, { endSession }) {
  const op = await startMockOp({ endSession });
  const origEnv = { ...process.env };
  let server = null;
  t.after(() => {
    if (server) server.close();
    op.server.close();
    process.env = origEnv;
    require('../utils/oidcClient').resetOidcClient();
  });
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'oidc';
  process.env.BASE_URL = BASE_URL;
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue535.db');
  process.env.SESSION_SECRET = 'issue535-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = op.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';
  process.env.SYSTEM_SYNC_SECRET = 'issue535-system-sync-secret-0123456789abcdef';
  process.env.DISABLE_INTERNAL_CALDAV = 'true';
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.HTTP_HEADER_AUTH_SECRET;
  delete process.env.CALDAVURL;

  require('../utils/oidcClient').resetOidcClient();
  const { app } = require('../index.js');
  trustTestCertificate(op.cert);
  server = http.createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;
  const browser = makeBrowser(origin);

  // Full interactive login: GET / → app → OP login form → submit → OP → callback → /.
  async function interactiveLogin() {
    const atOp = await browser.request('/');
    assert.equal(atOp.text, LOGIN_FORM, 'a browser without OP session sees the OP login form');
    const form = new URLSearchParams({ sub: 'testuser-sub', return_to: atOp.url });
    await browser.request(`${op.issuer}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const session = await browser.request('/api/auth/session');
    assert.equal(session.res.status, 200, 'the interactive login authenticates');
    assert.equal(JSON.parse(session.text).userId, 'testuser-sub');
  }

  const logout = () => browser.request('/api/auth/logout', { method: 'POST', headers: { Origin: BASE_URL } });
  return { op, browser, origin, interactiveLogin, logout };
}

test('Issue #535 — logout ends the OP session via end_session_endpoint (NODE_ENV=production)', async (t) => {
  const { op, browser, origin, interactiveLogin, logout } = await withApp(t, { endSession: true });
  await interactiveLogin();
  const oldSid = browser.cookie('connect.sid');

  const out = await logout();
  assert.equal(op.endSessionCalls.length, 1, 'logout must send the browser to the OP end_session_endpoint');
  const call = op.endSessionCalls[0];
  assert.equal(call.id_token_hint, op.issuedIdTokens.at(-1), 'id_token_hint is the id_token of this login');
  assert.equal(call.post_logout_redirect_uri, BASE_URL);
  assert.equal(call.client_id, CLIENT_ID);
  assert.equal(op.opSessions.size, 0, 'the OP session is ended');
  assert.equal(out.visited[0].status, 303, 'the logout POST answers with a 303 to the OP');

  const after = await browser.request('/api/auth/session');
  assert.equal(after.res.status, 401, 'the app session is gone');
  const replay = await fetch(`${origin}/api/auth/session`, { headers: { cookie: `connect.sid=${oldSid}` } });
  assert.equal(replay.status, 401, 'the session id of the login is destroyed server-side');

  const reload = await browser.request('/');
  assert.equal(reload.text, LOGIN_FORM, 'GET / after logout needs a fresh OP interaction');
  const still = await browser.request('/api/auth/session');
  assert.equal(still.res.status, 401, 'GET / after logout must not produce an authenticated session');
});

test('Issue #535 — without end_session_endpoint the next login requests prompt=login (NODE_ENV=production)', async (t) => {
  const { op, browser, interactiveLogin, logout } = await withApp(t, { endSession: false });
  await interactiveLogin();
  assert.notEqual(op.authorizeCalls[0].prompt, 'login', 'a first login does not force a prompt');

  const out = await logout();
  assert.equal(out.visited[0].status, 303);
  assert.equal(op.opSessions.size, 1, 'this OP cannot end its session');

  const reload = await browser.request('/');
  assert.equal(op.authorizeCalls.at(-1).prompt, 'login', 'the login after a logout requests prompt=login');
  assert.equal(reload.text, LOGIN_FORM, 'GET / after logout needs a fresh OP interaction');
  const still = await browser.request('/api/auth/session');
  assert.equal(still.res.status, 401, 'GET / after logout must not produce an authenticated session');

  // The interactive login at the OP completes the forced-prompt login.
  await browser.request(`${op.issuer}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sub: 'testuser-sub', return_to: reload.url }).toString()
  });
  assert.equal((await browser.request('/api/auth/session')).res.status, 200);
});
