'use strict';

/**
 * Issue #144 — in AUTH_METHOD=oidc the storage identity is the OIDC `sub` itself
 * (maintainer decision 2026-10-15). The internal Radicale account, every internal
 * calendar id and the calendar access checks key on the sub; the OIDC
 * preferred_username is a display name and never names or opens a collection.
 * A sub that is not safe as a path segment is refused with 401.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue144-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'webcalendar';
const HEADER_SECRET = 'issue144-header-auth-secret-0123456789abcdef';
const RADICALE = 'http://radicale.invalid:5232';

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

// Minimal IdP: issues an id_token with the given sub and preferred_username.
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
      const idToken = await new SignJWT({
        nonce: grant.nonce, email: 'testuser@example.com', preferred_username: grant.username
      })
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
    issueCode(nonce, sub, username) {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { nonce, sub, username });
      return code;
    }
  };
}

test('Issue #144 — the OIDC sub is the storage identity (NODE_ENV=production)', async (t) => {
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
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue144.db');
  process.env.SESSION_SECRET = 'issue144-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = idp.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';
  process.env.HTTP_HEADER_AUTH_SECRET = HEADER_SECRET;
  process.env.INTERNAL_CALDAV_URL = RADICALE;
  process.env.SYSTEM_SYNC_SECRET = 'issue144-system-sync-secret-0123456789abcdef';
  delete process.env.DISABLE_INTERNAL_CALDAV;
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.CALDAVURL;

  const { app } = require('../index.js');
  // After the app: server/index.js installs its own global dispatcher on load.
  trustTestCertificate(idp.cert);
  const Db = require('../db');
  const { checkCalendarAccess } = require('../utils/calendarAuth');
  server = http.createServer(app);
  const origin = `http://127.0.0.1:${await listen(server)}`;

  function cookieFrom(res) {
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || null;
  }

  async function oidcLogin(sub, username) {
    const start = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    const cookie = cookieFrom(start);
    const code = idp.issueCode(location.searchParams.get('nonce'), sub, username);
    const cb = await fetch(
      `${origin}/api/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
      { headers: { cookie }, redirect: 'manual' }
    );
    return { status: cb.status, cookie: cookieFrom(cb) || cookie };
  }

  async function internalAccount(cookie) {
    const res = await fetch(`${origin}/api/accounts`, { headers: { cookie } });
    assert.equal(res.status, 200);
    return (await res.json()).find((a) => a.id === 'internal-caldav');
  }

  // Member '2' holds the display name '1', which is another member's sub; it is created first.
  t.before(async () => {
    await Db.upsertUser('2', '1', 'testuser-b@example.com');
  });

  await t.test('after OIDC login as sub "1" the internal account is the collection root /1/', async () => {
    const login = await oidcLogin('1', 'testuser-a');
    assert.equal(login.status, 302, 'login with a safe sub succeeds');
    const acc = await internalAccount(login.cookie);
    assert.equal(acc.url, `${RADICALE}/1/`, 'Radicale collection root is keyed on the sub, not preferred_username');
    assert.equal(acc.username, '1', 'Radicale login is the sub, which the rights plugin compares to the path');
  });

  await t.test('the proxy header identity also keys the collection root on the sub', async () => {
    const res = await fetch(`${origin}/api/accounts`, {
      headers: { 'x-freeshard-secret': HEADER_SECRET, 'x-forwarded-user': '1' }
    });
    assert.equal(res.status, 200);
    const acc = (await res.json()).find((a) => a.id === 'internal-caldav');
    assert.equal(acc.url, `${RADICALE}/1/`);
  });

  await t.test('sub "1" owns, and can share, its own calendars', async () => {
    const req = { session: { userId: '1' } };
    const own = await checkCalendarAccess(req, 'internal-caldav::/1/personal/', 'owner');
    assert.equal(own.allowed, true);
    assert.equal(own.isOwner, true);
  });

  await t.test("a member whose display name equals another sub cannot reach that sub's collections", async () => {
    const intruder = { session: { userId: '2' } };
    const res = await checkCalendarAccess(intruder, 'internal-caldav::/1/personal/', 'read');
    assert.equal(res.allowed, false, 'username "1" must not make sub "2" the owner of /1/');

    // A calendar shared with sub "1" is not shared with the member called "1".
    await Db.upsertUser('3', 'testuser-c', 'testuser-c@example.com');
    await Db.addUserShare('internal-caldav::/3/team/', '1', 1, 'ACCEPTED', 'WRITE');
    const sharee = await checkCalendarAccess({ session: { userId: '1' } }, 'internal-caldav::/3/team/', 'write');
    assert.equal(sharee.allowed, true, 'the real sharee has access');
    const other = await checkCalendarAccess(intruder, 'internal-caldav::/3/team/', 'read');
    assert.equal(other.allowed, false, "sub '2' must not inherit shares granted to sub '1'");
  });

  await t.test('a sub that is not a safe path segment is refused with 401 at OIDC login', async () => {
    for (const sub of ['../2', 'a/b', '.', 'x%2f..']) {
      const login = await oidcLogin(sub, 'testuser-d');
      assert.equal(login.status, 401, `sub ${JSON.stringify(sub)} must be refused`);
      const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: login.cookie } });
      assert.equal(session.status, 401, `sub ${JSON.stringify(sub)} must not be logged in`);
    }
  });

  await t.test('a sub that is not a safe path segment is refused with 401 from the proxy header', async () => {
    for (const sub of ['../2', '2/personal', '..', 'a b']) {
      const res = await fetch(`${origin}/api/accounts`, {
        headers: { 'x-freeshard-secret': HEADER_SECRET, 'x-forwarded-user': sub }
      });
      assert.equal(res.status, 401, `header identity ${JSON.stringify(sub)} must be refused`);
    }
  });
});
