'use strict';

/**
 * Issue #491 — the return from an OAuth/OIDC provider on another site must carry the session.
 *
 * The real server app runs in the shipping configuration (NODE_ENV=production, COOKIE_SAME_SITE
 * unset). A small browser model drives it: it keeps the cookies the app sets together with their
 * SameSite attribute and, like a browser (RFC 6265bis §5.8.3), withholds SameSite=Strict cookies
 * from a top-level navigation that is cross-site or passed through another site on its redirect
 * chain. SameSite=Lax cookies go along with such a top-level GET.
 *
 *  - OIDC login: /api/auth/login → stub identity provider on another site → /api/auth/callback.
 *  - Google linking: /api/auth/google → stub accounts.google.com → /api/auth/google/callback, for a
 *    fresh session and for a session stored with SameSite=Strict before the default changed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { MockAgent, setGlobalDispatcher } = require('undici');
const { createTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue491-oauth-'));
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

// A stub identity provider. /authorize plays the user who consents: it answers with the redirect
// back to the client, carrying a code bound to the PKCE challenge and nonce of the request.
async function startStubIdp() {
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
    if (url.pathname === '/authorize') {
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri')
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const derived = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (!grant || form.get('redirect_uri') !== grant.redirectUri || derived !== grant.challenge) {
        return json(400, { error: 'invalid_grant' });
      }
      const idToken = await new SignJWT({ email: 'testuser@example.com', preferred_username: 'testuser', nonce: grant.nonce })
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
  return { server, issuer, cert: tls.cert };
}

/**
 * A browser model: one cookie jar for the app's site, top-level navigations that follow redirects.
 * URLs on BASE_URL's host are served by the local app (like DNS); the stub providers are other sites.
 */
function createBrowser(appOrigin, idpOrigin) {
  const appSite = new URL(BASE_URL).hostname;
  const jar = new Map(); // name → { value, sameSite }
  const routes = new Map(); // hostname → (url) => redirect target, for providers stubbed in-process

  function store(setCookies) {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const sameSiteAttr = attrs.find((a) => /^samesite=/i.test(a));
      // No attribute means Lax in current browsers.
      const sameSite = sameSiteAttr ? sameSiteAttr.split('=')[1].toLowerCase() : 'lax';
      jar.set(pair.slice(0, eq), { value: pair.slice(eq + 1), sameSite });
    }
  }

  function cookieHeader(crossSite) {
    return [...jar].filter(([, c]) => !crossSite || c.sameSite !== 'strict')
      .map(([name, c]) => `${name}=${c.value}`).join('; ');
  }

  async function navigate(startUrl, { initiatorSite = appSite } = {}) {
    let url = new URL(startUrl);
    let crossSite = false;
    for (let hop = 0; hop < 10; hop++) {
      crossSite = crossSite || url.hostname !== initiatorSite;
      let location;
      if (url.hostname === appSite) {
        const headers = {};
        const cookie = cookieHeader(crossSite);
        if (cookie) headers.cookie = cookie;
        const res = await fetch(`${appOrigin}${url.pathname}${url.search}`, { headers, redirect: 'manual' });
        store(res.headers.getSetCookie());
        if (res.status < 300 || res.status >= 400) return { status: res.status, url, text: await res.text() };
        location = res.headers.get('location');
      } else if (routes.has(url.hostname)) {
        location = routes.get(url.hostname)(url);
      } else {
        assert.equal(url.origin, idpOrigin, `unexpected navigation to ${url.href}`);
        const res = await fetch(url, { redirect: 'manual' });
        assert.equal(res.status, 302, `identity provider answered ${res.status} for ${url.href}`);
        location = res.headers.get('location');
      }
      crossSite = crossSite || url.hostname !== appSite;
      url = new URL(location, url);
    }
    throw new Error('too many redirects');
  }

  return {
    jar,
    navigate,
    route(hostname, handler) { routes.set(hostname, handler); },
    setCookie(header, sameSite) {
      const [name, value] = header.split(/=(.*)/s);
      jar.set(name, { value, sameSite });
    }
  };
}

test('Issue #491 — OAuth/OIDC return from another site carries the session (default configuration)', async (t) => {
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
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue491.db');
  process.env.SESSION_SECRET = 'issue491-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.OIDC_ISSUER_URL = idp.issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'testuser-google-client';
  process.env.GOOGLE_CLIENT_SECRET = 'testuser-google-secret';
  // The shipping default is under test.
  delete process.env.COOKIE_SAME_SITE;
  delete process.env.HTTP_HEADER_AUTH;
  delete process.env.HTTP_HEADER_AUTH_SECRET;

  const { app } = require('../index.js');
  const Db = require('../db');
  const { loginAs } = require('./helpers/testSession');

  // After the app: server/index.js installs its own global dispatcher on load. Google's token and
  // userinfo endpoints are stubbed; everything else (app, stub IdP) is real network.
  const google = new MockAgent({ connect: { ca: idp.cert } });
  google.enableNetConnect();
  setGlobalDispatcher(google);
  google.get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(200, { access_token: 'testuser-google-access', refresh_token: 'testuser-google-refresh', expires_in: 3600 })
    .persist();
  google.get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
    .reply(200, { email: 'testuser@example.com', name: 'Test User' })
    .persist();

  server = http.createServer(app);
  const appOrigin = `http://127.0.0.1:${await listen(server)}`;

  // Stub accounts.google.com: the user consents, Google redirects back with a code and the state.
  function stubGoogleConsent(browser) {
    browser.route('accounts.google.com', (url) => {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'testuser-google-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      return back.href;
    });
  }

  const sessionUser = async (browser) => {
    const res = await fetch(`${appOrigin}/api/auth/session`, {
      headers: { cookie: [...browser.jar].map(([n, c]) => `${n}=${c.value}`).join('; ') }
    });
    return (await res.json()).userId || null;
  };

  await t.test('the session cookie is issued SameSite=Lax by default', async () => {
    const browser = createBrowser(appOrigin, idp.issuer);
    await browser.navigate(`${BASE_URL}/api/auth/login`);
    assert.equal(browser.jar.get('connect.sid')?.sameSite, 'lax');
  });

  await t.test('OIDC login: redirect → stub provider on another site → callback logs the user in', async () => {
    const browser = createBrowser(appOrigin, idp.issuer);
    const result = await browser.navigate(`${BASE_URL}/api/auth/login`);
    assert.equal(result.url.pathname, '/', `the callback must end on the app, got ${result.status} at ${result.url.pathname}: ${result.text.slice(0, 200)}`);
    assert.ok(await sessionUser(browser), 'the browser holds a logged-in session after the round trip');
  });

  await t.test('Google linking: the cross-site return to /api/auth/google/callback links the account', async () => {
    const browser = createBrowser(appOrigin, idp.issuer);
    await browser.navigate(`${BASE_URL}/api/auth/login`);
    const userId = await sessionUser(browser);
    assert.ok(userId, 'precondition: logged in');
    stubGoogleConsent(browser);

    const result = await browser.navigate(`${BASE_URL}/api/auth/google`);
    assert.equal(result.url.pathname, '/api/auth/google/callback');
    assert.equal(result.status, 200, `callback must succeed, got ${result.status}: ${result.text}`);
    assert.match(result.text, /Verbindung erfolgreich/);
    const accounts = await Db.getAccounts(userId);
    assert.ok(accounts.some((a) => a.username === 'testuser@example.com'), 'the Google account is stored for the user');
  });

  await t.test('a session stored with SameSite=Strict before the change also survives the return', async () => {
    const browser = createBrowser(appOrigin, idp.issuer);
    // Created and received under the old default: stored with sameSite 'strict', held by the browser as Strict.
    browser.setCookie(await loginAs('testuser-491-legacy', { username: 'testuser@example.com' }), 'strict');
    stubGoogleConsent(browser);

    const result = await browser.navigate(`${BASE_URL}/api/auth/google`);
    assert.equal(browser.jar.get('connect.sid')?.sameSite, 'lax', 'the stored session must be re-issued as SameSite=Lax');
    assert.equal(result.status, 200, `callback must succeed, got ${result.status}: ${result.text}`);
    assert.match(result.text, /Verbindung erfolgreich/);
  });
});
