'use strict';
/**
 * Issue #97 — Microsoft 365 connection through the web app.
 *
 * (c) a real OAuth 2.0 authorization code flow with PKCE at tenant "common": the state is always
 *     required, the redirect URI comes from BASE_URL, and no token is ever taken from a request
 *     body or invented. Without MSGRAPH_CLIENT_ID the integration reports itself unavailable.
 * The sync itself runs only in sync-worker/msgraph_worker.py (server/test/python/
 * test_issue97_msgraph_delta_sync.py); the web app's sync route just enqueues a job.
 *
 * Microsoft is a local fake: globalThis.fetch is wrapped so requests to login.microsoftonline.com
 * and graph.microsoft.com are answered in-process following the documented contracts.
 */
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3311';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.BASE_URL = 'https://calendar.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Db = require('../db');

const CLIENT_ID = '00000000-0000-0000-0000-00000000c1d0';
const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

test('Issue #97 — Microsoft 365 OAuth connection and single sync path', async (t) => {
  const { server } = require('../index');
  const { loginAs } = require('./helpers/testSession');
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT, resolve));
  }
  await Db.ready;

  const appUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'issue97-testuser';
  const testFetch = globalThis.fetch;
  let microsoft;

  // The fake Microsoft endpoints; everything else (the test's own requests) passes through.
  function fakeMicrosoft({ tokenStatus = 200, tokens, me = { mail: 'testuser@example.com' } } = {}) {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith('https://login.microsoftonline.com/') || url.startsWith('https://graph.microsoft.com/')) {
        calls.push({ url, init, body: init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null });
        if (url === TOKEN_URL) {
          return new Response(JSON.stringify(tokens || {
            access_token: 'testuser-access-token', refresh_token: 'testuser-refresh-token', expires_in: 3600
          }), { status: tokenStatus, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === 'https://graph.microsoft.com/v1.0/me') {
          return new Response(JSON.stringify(me), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('unexpected', { status: 500 });
      }
      return testFetch(input, init);
    };
    return calls;
  }

  t.beforeEach(async () => {
    process.env.MSGRAPH_CLIENT_ID = CLIENT_ID;
    delete process.env.MSGRAPH_CLIENT_SECRET;
    await Db.clearAll();
    for (const account of await Db.getMSGraphAccounts(userId)) await Db.deleteMSGraphAccount(account.id);
    microsoft = fakeMicrosoft();
  });
  t.afterEach(() => { globalThis.fetch = testFetch; });
  t.after(() => {
    delete process.env.MSGRAPH_CLIENT_ID;
    delete process.env.BASE_URL;
    delete process.env.PORT;
    server.close();
  });

  async function get(path, cookie, headers = {}) {
    return fetch(`${appUrl}${path}`, { headers: { cookie, ...headers }, redirect: 'manual' });
  }

  async function authorize(cookie) {
    const res = await get('/api/msgraph/authorize', cookie);
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location'));
  }

  await t.test('authorize redirects to Microsoft with PKCE S256, state and a BASE_URL redirect URI', async () => {
    const cookie = await loginAs(userId);
    const res = await get('/api/msgraph/authorize', cookie, { 'X-Forwarded-Host': 'evil.example.com' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(`${location.origin}${location.pathname}`, AUTHORIZE_URL);
    const q = location.searchParams;
    assert.equal(q.get('client_id'), CLIENT_ID);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('redirect_uri'), 'https://calendar.example.com/api/msgraph/callback');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(q.get('state') && q.get('state').length >= 16, 'a random state is sent');
    assert.deepEqual(new Set(q.get('scope').split(' ')), new Set(['offline_access', 'User.Read', 'Calendars.ReadWrite']));
    assert.equal(microsoft.length, 0, 'starting the flow calls nobody');
  });

  await t.test('the callback exchanges the code with the PKCE verifier and stores the real tokens', async () => {
    process.env.MSGRAPH_CLIENT_SECRET = 'testuser-client-secret';
    const cookie = await loginAs(userId);
    const location = await authorize(cookie);
    const state = location.searchParams.get('state');

    const res = await get(`/api/msgraph/callback/complete?code=testuser-auth-code&state=${encodeURIComponent(state)}`, cookie);

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://calendar.example.com/?msgraph=connected');
    const exchange = microsoft.find(c => c.url === TOKEN_URL);
    assert.ok(exchange, 'the code is exchanged at the token endpoint');
    assert.equal(exchange.body.grant_type, 'authorization_code');
    assert.equal(exchange.body.code, 'testuser-auth-code');
    assert.equal(exchange.body.client_id, CLIENT_ID);
    assert.equal(exchange.body.client_secret, 'testuser-client-secret');
    assert.equal(exchange.body.redirect_uri, 'https://calendar.example.com/api/msgraph/callback');
    assert.deepEqual(new Set(exchange.body.scope.split(' ')), new Set(['offline_access', 'User.Read', 'Calendars.ReadWrite']));
    const challenge = crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url');
    assert.equal(challenge, location.searchParams.get('code_challenge'), 'the verifier matches the challenge sent');

    const accounts = await Db.getMSGraphAccounts(userId);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].accountEmail, 'testuser@example.com');
    assert.equal(accounts[0].accessToken, 'testuser-access-token');
    assert.equal(accounts[0].refreshToken, 'testuser-refresh-token');
    assert.ok(accounts[0].expiresAt > Date.now());
    const jobs = await Db.getSyncJobs(userId);
    assert.equal(jobs.filter(j => j.status === 'PENDING').length, 1, 'connecting enqueues the first sync');

    const replay = await get(`/api/msgraph/callback/complete?code=testuser-auth-code&state=${encodeURIComponent(state)}`, cookie);
    assert.equal(replay.status, 400, 'a state is used once');
  });

  await t.test('the registered callback forwards same-site without needing the session cookie', async () => {
    // Microsoft's redirect is cross-site, so with COOKIE_SAME_SITE=strict the browser withholds the cookie here.
    const res = await get('/api/msgraph/callback?code=testuser-code&state=s%22%3E%3Cscript%3E&error=e%22%3E%3Cscript%3E&extra=x', '');
    assert.equal(res.status, 200);
    const html = await res.text();
    const target = 'https://calendar.example.com/api/msgraph/callback/complete?code=testuser-code&amp;state=s%22%3E%3Cscript%3E&amp;error=e%22%3E%3Cscript%3E';
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0;url=${target}">`), html);
    assert.ok(!html.includes('<script>') && !html.includes('extra'), 'nothing but code, state and error is forwarded, encoded');
    assert.equal(microsoft.length, 0, 'the forwarding page exchanges nothing');
  });

  await t.test('a public client sends no client_secret', async () => {
    const cookie = await loginAs(userId);
    const state = (await authorize(cookie)).searchParams.get('state');
    await get(`/api/msgraph/callback/complete?code=c&state=${encodeURIComponent(state)}`, cookie);
    const exchange = microsoft.find(c => c.url === TOKEN_URL);
    assert.ok(!('client_secret' in exchange.body));
  });

  await t.test('the state is always required and must match this session', async () => {
    const cookie = await loginAs(userId);
    const noFlow = await get('/api/msgraph/callback/complete?code=c&state=anything', cookie);
    assert.equal(noFlow.status, 400, 'no callback without a started flow');

    await authorize(cookie);
    const missing = await get('/api/msgraph/callback/complete?code=c', cookie);
    assert.equal(missing.status, 400, 'a missing state is rejected');

    const otherSession = await loginAs(userId);
    const foreignState = (await authorize(otherSession)).searchParams.get('state');
    await authorize(cookie);
    const wrong = await get(`/api/msgraph/callback/complete?code=c&state=${encodeURIComponent(foreignState)}`, cookie);
    assert.equal(wrong.status, 400, "another session's state is rejected");

    assert.equal(microsoft.length, 0, 'no code is exchanged without a matching state');
    assert.equal((await Db.getMSGraphAccounts(userId)).length, 0);
  });

  await t.test('a refused authorization or failed exchange stores nothing and echoes nothing', async () => {
    const cookie = await loginAs(userId);
    let state = (await authorize(cookie)).searchParams.get('state');
    const denied = await get(`/api/msgraph/callback/complete?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=${encodeURIComponent(state)}`, cookie);
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get('location'), 'https://calendar.example.com/?msgraph=error');
    assert.ok(!(await denied.text()).includes('<script>'));

    microsoft = fakeMicrosoft({ tokenStatus: 400, tokens: { error: 'invalid_grant' } });
    state = (await authorize(cookie)).searchParams.get('state');
    const failed = await get(`/api/msgraph/callback/complete?code=c&state=${encodeURIComponent(state)}`, cookie);
    assert.equal(failed.headers.get('location'), 'https://calendar.example.com/?msgraph=error');
    assert.equal((await Db.getMSGraphAccounts(userId)).length, 0);
  });

  await t.test('no account is stored without a refresh token or a mailbox address from Microsoft', async () => {
    const cookie = await loginAs(userId);
    for (const fake of [
      { tokens: { access_token: 'testuser-access-token', expires_in: 3600 } },
      { me: { displayName: 'Test User' } }
    ]) {
      microsoft = fakeMicrosoft(fake);
      const state = (await authorize(cookie)).searchParams.get('state');
      const res = await get(`/api/msgraph/callback/complete?code=c&state=${encodeURIComponent(state)}`, cookie);
      assert.equal(res.headers.get('location'), 'https://calendar.example.com/?msgraph=error');
    }
    assert.equal((await Db.getMSGraphAccounts(userId)).length, 0, 'no invented token or address is stored');
  });

  await t.test('reconnecting the same mailbox replaces its tokens and clears the reconnect flag', async () => {
    const existing = await Db.addMSGraphAccount({
      userId, accountEmail: 'TestUser@example.com', accessToken: 'testuser-old-access',
      refreshToken: 'testuser-old-refresh', expiresAt: 0
    });
    await Db.updateMSGraphAccount(existing.id, { reconnectRequired: true });
    const cookie = await loginAs(userId);
    const state = (await authorize(cookie)).searchParams.get('state');

    await get(`/api/msgraph/callback/complete?code=c&state=${encodeURIComponent(state)}`, cookie);

    const accounts = await Db.getMSGraphAccounts(userId);
    assert.equal(accounts.length, 1, 'no second row for the same mailbox');
    assert.equal(accounts[0].id, existing.id);
    assert.equal(accounts[0].refreshToken, 'testuser-refresh-token');
    assert.equal(accounts[0].reconnectRequired, false);
  });

  await t.test('no account can be created from tokens in a request body', async () => {
    const cookie = await loginAs(userId);
    const res = await fetch(`${appUrl}/api/msgraph/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ accountEmail: 'testuser@example.com', accessToken: 'testuser-token' })
    });
    assert.equal(res.status, 404);
    assert.equal((await Db.getMSGraphAccounts(userId)).length, 0);
  });

  await t.test('without MSGRAPH_CLIENT_ID the integration is unavailable, the rest keeps working', async () => {
    delete process.env.MSGRAPH_CLIENT_ID;
    const cookie = await loginAs(userId);

    const list = await get('/api/msgraph/accounts', cookie);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).available, false);

    const start = await get('/api/msgraph/authorize', cookie);
    assert.equal(start.status, 503);
    assert.match((await start.json()).error, /MSGRAPH_CLIENT_ID/);

    process.env.MSGRAPH_CLIENT_ID = CLIENT_ID;
    assert.equal((await (await get('/api/msgraph/accounts', cookie)).json()).available, true);
  });

  await t.test('a sync request only enqueues a job for the worker and never calls Graph itself', async () => {
    const account = await Db.addMSGraphAccount({
      userId, accountEmail: 'testuser@example.com', accessToken: 'testuser-access-token',
      refreshToken: 'testuser-refresh-token', expiresAt: 0
    });
    const cookie = await loginAs(userId);

    const res = await fetch(`${appUrl}/api/msgraph/accounts/${account.id}/sync`, { method: 'POST', headers: { cookie } });

    assert.equal(res.status, 202);
    assert.equal(microsoft.length, 0, 'the web app holds no second Graph sync path');
    const jobs = await Db.getSyncJobs(userId);
    assert.equal(jobs.filter(j => j.status === 'PENDING').length, 1);
  });
});
