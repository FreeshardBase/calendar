'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

process.env.NODE_ENV = 'test';
process.env.PREVENT_AUTO_LISTEN = 'true';

const Db = require('../db');
const accountsRouter = require('../routes/accounts');
const { app } = require('../index');

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  update(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const header of raw) {
      if (!header) continue;
      const part = header.split(';')[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        const key = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim();
        this.cookies.set(key, val);
      }
    }
  }
  header() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function jarFetch(baseUrl, jar, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookieHdr = jar.header();
  if (cookieHdr) {
    headers['Cookie'] = cookieHdr;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers
  });
  jar.update(res);
  return res;
}

test('Issue #51: unauthenticated POST /api/accounts session hijacking prevention', async (t) => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => {
    server.close();
  });

  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  await t.test('ClaydeCode reproduction: unauthenticated POST /api/accounts cannot flip session identity to seeded victim', async () => {
    const victimUserId = 'victim-uuid-0001';
    await Db.upsertUser(victimUserId, 'victim@example.com');

    const jar = new CookieJar();

    // 1. control: GET /api/calendars with fresh jar returns 401
    const resControl = await jarFetch(baseUrl, jar, '/api/calendars');
    assert.strictEqual(resControl.status, 401, 'control GET /api/calendars must return 401 with fresh jar');

    // 2. attack: POST /api/accounts with victim identity in body must be rejected with 401
    const resAttack = await jarFetch(baseUrl, jar, '/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://example.com/caldav',
        username: victimUserId,
        password: 'password'
      })
    });
    assert.strictEqual(resAttack.status, 401, 'attack POST /api/accounts must return 401 Unauthorized');
    const attackBody = await resAttack.json();
    assert.strictEqual(attackBody.error, 'Authentication required');

    // 3. after: GET /api/calendars with same cookie jar must STILL return 401 (not 200)
    const resAfter = await jarFetch(baseUrl, jar, '/api/calendars');
    assert.strictEqual(resAfter.status, 401, 'after GET /api/calendars must return 401 Unauthorized (session identity must not flip to victim)');

    // 4. Verify no linked_accounts row was persisted for victim
    const accounts = await Db.getAccounts(victimUserId);
    const nonDefaultAccounts = accounts.filter(a => a.id !== 'internal-caldav' && a.id !== 'env-default');
    assert.strictEqual(nonDefaultAccounts.length, 0, 'No linked_accounts row must be persisted for victim');
  });

  await t.test('ClaydeCode reproduction: failed POST /api/accounts must not flip session to victim (unseeded or error state)', async () => {
    const unseededVictim = 'victim-uuid-unseeded-0002';
    const jar = new CookieJar();

    // 1. control: fresh jar -> 401
    const resControl = await jarFetch(baseUrl, jar, '/api/calendars');
    assert.strictEqual(resControl.status, 401);

    // 2. attack: unauthenticated POST /api/accounts
    const resAttack = await jarFetch(baseUrl, jar, '/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://127.0.0.1:1/nonexistent',
        username: unseededVictim,
        password: 'password'
      })
    });
    assert.strictEqual(resAttack.status, 401, 'POST /api/accounts must return 401 before any network call or DB insert');

    // 3. after: subsequent GET /api/calendars must return 401, NOT 200 scoped to internal-caldav::/victim/personal/
    const resAfter = await jarFetch(baseUrl, jar, '/api/calendars');
    assert.strictEqual(resAfter.status, 401, 'after GET /api/calendars must return 401 (must not scope session to unseeded victim)');
  });

  await t.test('Defense-in-depth: accountsRouter directly rejects unauthenticated requests across all paths', async () => {
    const subApp = express();
    subApp.use(express.json());
    subApp.use(session({
      secret: 'test-issue51-direct-secret',
      resave: false,
      saveUninitialized: true
    }));
    subApp.use('/api/accounts', accountsRouter);

    const subServer = http.createServer(subApp);
    await new Promise(resolve => subServer.listen(0, resolve));
    const subPort = subServer.address().port;
    const subBaseUrl = `http://localhost:${subPort}`;

    try {
      const jar = new CookieJar();

      // GET /api/accounts without session identity -> 401
      const resGet = await jarFetch(subBaseUrl, jar, '/api/accounts');
      assert.strictEqual(resGet.status, 401, 'Direct GET /api/accounts without session userId must return 401');

      // POST /api/accounts without session identity -> 401
      const resPost = await jarFetch(subBaseUrl, jar, '/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'http://example.com/caldav',
          username: 'direct-attacker-victim',
          password: 'password'
        })
      });
      assert.strictEqual(resPost.status, 401, 'Direct POST /api/accounts without session userId must return 401');

      // PATCH /api/accounts/:id without session identity -> 401
      const resPatch = await jarFetch(subBaseUrl, jar, '/api/accounts/some-acc-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Hacked' })
      });
      assert.strictEqual(resPatch.status, 401, 'Direct PATCH /api/accounts/:id without session userId must return 401');

      // DELETE /api/accounts/:id without session identity -> 401
      const resDeleteOne = await jarFetch(subBaseUrl, jar, '/api/accounts/some-acc-id', {
        method: 'DELETE'
      });
      assert.strictEqual(resDeleteOne.status, 401, 'Direct DELETE /api/accounts/:id without session userId must return 401');

      // DELETE /api/accounts without session identity -> 401
      const resDeleteAll = await jarFetch(subBaseUrl, jar, '/api/accounts', {
        method: 'DELETE'
      });
      assert.strictEqual(resDeleteAll.status, 401, 'Direct DELETE /api/accounts without session userId must return 401');
    } finally {
      subServer.close();
    }
  });
});
