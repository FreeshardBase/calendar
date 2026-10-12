'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3497';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { graphEventToVEVENT, veventToGraphEvent, MSGraphSyncEngine } = require('../utils/msgraph');

test('Issue #97 — MS Graph Sync Engine End-to-End Five Defects Suite', async (t) => {
  const { app, server } = require('../index');
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3297, resolve));
  }
  await new Promise(r => setTimeout(r, 100));

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'msgraph-issue97-testuser';

  const account = await Db.addMSGraphAccount({
    userId,
    accountEmail: 'issue97@example.com',
    tenantId: 'common',
    clientId: 'client-issue97',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    expiresAt: Date.now() - 1000 // Expired to trigger refresh
  });

  t.after(async () => {
    await Db.deleteMSGraphAccount(account.id);
  });

  // ---------------------------------------------------------------------------
  // Defect (e): Timezone handling in graphEventToVEVENT and Prefer header in fetchRemoteDeltaEvents
  // ---------------------------------------------------------------------------
  await t.test('Defect (e): graphEventToVEVENT must convert W. Europe Standard Time to UTC without 2-hour drift', () => {
    const realisticPayload = {
      id: 'graph-tz-1',
      subject: 'Strategy Meeting',
      start: { dateTime: '2026-10-05T14:00:00.0000000', timeZone: 'W. Europe Standard Time' },
      end: { dateTime: '2026-10-05T15:30:00.0000000', timeZone: 'W. Europe Standard Time' }
    };

    const vevent = graphEventToVEVENT(realisticPayload);
    assert.ok(vevent, 'vevent must be parsed');
    // On 2026-10-05, CEST (UTC+2) is active in Western Europe. 14:00 local is 12:00 UTC.
    assert.equal(vevent.start, '2026-10-05T12:00:00.000Z', 'start must be converted to 12:00:00.000Z, not 14:00Z (zero drift)');
    assert.equal(vevent.end, '2026-10-05T13:30:00.000Z', 'end must be converted to 13:30:00.000Z, not 15:30Z');
  });

  await t.test('Defect (e): fetchRemoteDeltaEvents must send Prefer: outlook.timezone="UTC" header', async () => {
    let capturedHeaders = null;
    const mockFetch = async (url, options = {}) => {
      capturedHeaders = options.headers || {};
      return {
        ok: true,
        json: async () => ({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?token=abc'
        })
      };
    };

    const engine = new MSGraphSyncEngine({ ...account, accessToken: 'valid-token', expiresAt: Date.now() + 3600000 }, mockFetch);
    await engine.fetchRemoteDeltaEvents();

    assert.ok(capturedHeaders, 'fetchRemoteDeltaEvents must make HTTP request');
    const prefer = capturedHeaders['Prefer'] || capturedHeaders['prefer'];
    assert.ok(prefer, 'Must send Prefer header');
    assert.match(prefer, /outlook\.timezone\s*=\s*"?UTC"?/i, 'Prefer header must specify outlook.timezone="UTC"');
  });

  // ---------------------------------------------------------------------------
  // Defect (a): Delta endpoint default, pagination cursor never stored as delta token, @removed handling
  // ---------------------------------------------------------------------------
  await t.test('Defect (a): default endpoint must be /me/events/delta, not plain /me/events', async () => {
    let requestedEndpoint = null;
    const mockFetch = async (url) => {
      requestedEndpoint = url;
      return {
        ok: true,
        json: async () => ({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?initialDelta'
        })
      };
    };

    // Engine instantiated without an existing deltaLink
    const freshAccount = { ...account, deltaLink: null, accessToken: 'valid-token', expiresAt: Date.now() + 3600000 };
    const engine = new MSGraphSyncEngine(freshAccount, mockFetch);
    const result = await engine.fetchRemoteDeltaEvents();

    assert.match(requestedEndpoint, /\/me\/events\/delta/i, 'Initial query must hit delta endpoint, not plain /me/events');
    assert.equal(result.deltaLink, 'https://graph.microsoft.com/v1.0/me/events/delta?initialDelta');
  });

  await t.test('Defect (a): two-page non-delta response must NEVER persist pagination cursor ($skip) as deltaLink', async () => {
    const mockFetch = async (url) => {
      if (url.includes('$skip=10')) {
        // Page 2: end of pagination but no @odata.deltaLink returned
        return {
          ok: true,
          json: async () => ({
            value: [{ id: 'ev2', subject: 'Event 2', start: { dateTime: '2026-10-01T11:00:00Z', timeZone: 'UTC' } }]
            // Notice: no @odata.deltaLink here!
          })
        };
      }
      // Page 1: returns nextLink with $skip=10
      return {
        ok: true,
        json: async () => ({
          value: [{ id: 'ev1', subject: 'Event 1', start: { dateTime: '2026-10-01T10:00:00Z', timeZone: 'UTC' } }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/events?$skip=10'
        })
      };
    };

    const engine = new MSGraphSyncEngine({ ...account, accessToken: 'valid-token', expiresAt: Date.now() + 3600000, deltaLink: null }, mockFetch);
    const result = await engine.fetchRemoteDeltaEvents();

    assert.equal(result.events.length, 2, 'Should fetch both pages');
    assert.doesNotMatch(result.deltaLink, /\$skip=/i, 'deltaLink must NEVER be a pagination cursor like $skip=10');
  });

  await t.test('Defect (a): @removed events must be deleted locally from CalDAV and event mappings', async () => {
    const deletedGraphId = 'graph-to-delete-123';
    const localUid = 'msgraph-event-local-del-123';
    await Db.upsertMSGraphEventMapping(localUid, deletedGraphId, account.id, 'etag-del');

    let deletedCalDAVUrl = null;
    const mockCalDAVClient = {
      delete: async (url) => { deletedCalDAVUrl = url; }
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        value: [
          { id: deletedGraphId, '@removed': { reason: 'deleted' } }
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?tokenAfterDelete'
      })
    });

    const targetCalendarUrl = 'http://localhost:1080/users/msgraph-issue97-testuser/calendars/personal';
    const engine = new MSGraphSyncEngine({ ...account, accessToken: 'valid-token', expiresAt: Date.now() + 3600000 }, mockFetch, mockCalDAVClient, targetCalendarUrl);
    const syncRes = await engine.sync([]);

    assert.equal(deletedCalDAVUrl, `${targetCalendarUrl}/${localUid}.ics`, 'CalDAV event must be deleted via client.delete');
    const mapping = await Db.getMSGraphEventMapping(localUid);
    assert.equal(mapping, null, 'Event mapping must be deleted from SQLite');
    assert.ok(syncRes.syncedItems.some(i => i.action === 'deleted_locally' && i.graphId === deletedGraphId), 'syncedItems must report deleted_locally');
  });

  // ---------------------------------------------------------------------------
  // Defect (b): Token refresh payload must include scope, client_secret, and configured client_id
  // ---------------------------------------------------------------------------
  await t.test('Defect (b): ensureAccessToken payload must include scope, client_secret, and client_id', async () => {
    let capturedBodyParams = null;
    const mockFetch = async (url, options = {}) => {
      if (url.includes('/token')) {
        capturedBodyParams = new URLSearchParams(options.body.toString());
        return {
          ok: true,
          json: async () => ({
            access_token: 'refreshed-access-token',
            refresh_token: 'refreshed-refresh-token',
            expires_in: 3600
          })
        };
      }
      return { ok: true, json: async () => ({ value: [] }) };
    };

    const testAccount = {
      ...account,
      clientId: 'configured-client-id',
      clientSecret: 'configured-client-secret',
      scope: 'offline_access https://graph.microsoft.com/Calendars.ReadWrite'
    };

    const engine = new MSGraphSyncEngine(testAccount, mockFetch);
    await engine.ensureAccessToken();

    assert.ok(capturedBodyParams, 'Must call token endpoint');
    assert.equal(capturedBodyParams.get('client_id'), 'configured-client-id', 'client_id must match configured account client_id');
    assert.equal(capturedBodyParams.get('client_secret'), 'configured-client-secret', 'client_secret must be included when configured');
    assert.ok(capturedBodyParams.get('scope'), 'scope must be included in refresh token request');
    assert.match(capturedBodyParams.get('scope'), /Calendars\.ReadWrite|offline_access/i, 'scope must request calendar permissions');
  });

  // ---------------------------------------------------------------------------
  // Defect (c): No mock token fabrication on POST /api/msgraph/accounts + MS Graph OAuth PKCE flow
  // ---------------------------------------------------------------------------
  await t.test('Defect (c): POST /api/msgraph/accounts must reject when tokens are omitted (no mock token fabrication)', async () => {
    const existingBefore = await Db.getMSGraphAccounts(userId);
    for (const acc of existingBefore) {
      if (acc.accountEmail === 'nomock@example.com') {
        await Db.deleteMSGraphAccount(acc.id);
      }
    }

    const res = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({
        accountEmail: 'nomock@example.com',
        tenantId: 'common'
        // accessToken and refreshToken omitted
      })
    });

    assert.equal(res.status, 400, 'POST /api/msgraph/accounts must return 400 Bad Request when tokens are omitted');
    const data = await res.json();
    assert.match(data.error, /token/i, 'Error message must state that tokens are required');

    // Confirm no account was created with fabricated tokens
    const accounts = await Db.getMSGraphAccounts(userId);
    const created = accounts.find(a => a.accountEmail === 'nomock@example.com');
    assert.equal(created, undefined, 'No account must be saved with fabricated mock tokens');
  });

  await t.test('Defect (c): GET /api/msgraph/authorize must implement PKCE authorize redirect', async () => {
    const res = await fetch(`${baseUrl}/api/msgraph/authorize`, {
      headers: { 'x-test-user-id': userId },
      redirect: 'manual'
    });

    assert.ok([302, 303, 307].includes(res.status), `Must return HTTP redirect, got ${res.status}`);
    const location = res.headers.get('location');
    assert.ok(location, 'Must provide Location redirect header');
    const authUrl = new URL(location);
    assert.equal(authUrl.hostname, 'login.microsoftonline.com');
    assert.match(authUrl.pathname, /\/oauth2\/v2\.0\/authorize$/);
    assert.equal(authUrl.searchParams.get('response_type'), 'code');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authUrl.searchParams.get('code_challenge'), 'Must generate and send code_challenge');
    assert.ok(authUrl.searchParams.get('state'), 'Must generate and send state parameter');
    assert.ok(authUrl.searchParams.get('redirect_uri'), 'Must include redirect_uri');
  });

  await t.test('Defect (c): GET /api/auth/msgraph must redirect to /api/msgraph/authorize', async () => {
    const res = await fetch(`${baseUrl}/api/auth/msgraph`, {
      headers: { 'x-test-user-id': userId },
      redirect: 'manual'
    });
    assert.ok([302, 303, 307].includes(res.status), `Must return HTTP redirect, got ${res.status}`);
    const location = res.headers.get('location');
    assert.ok(location.includes('/api/msgraph/authorize'), 'Must redirect to /api/msgraph/authorize');
  });

  await t.test('Defect (c): GET /api/msgraph/callback must exchange code via PKCE and persist account', async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = async (url, options = {}) => {
        const urlStr = url.toString();
        if (urlStr.includes('login.microsoftonline.com') && urlStr.includes('/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'pkce-callback-access-tok',
              refresh_token: 'pkce-callback-refresh-tok',
              expires_in: 3600
            })
          };
        }
        if (urlStr.includes('graph.microsoft.com/v1.0/me')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              mail: 'pkceuser@organization.com',
              displayName: 'PKCE Test User'
            })
          };
        }
        return origFetch(url, options);
      };

      const res = await fetch(`${baseUrl}/api/msgraph/callback?code=mock-auth-code&state=dummy-state`, {
        headers: { 'x-test-user-id': userId }
      });

      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('msgraph-account-linked'), 'Callback must post msgraph-account-linked message to opener');

      const accounts = await Db.getMSGraphAccounts(userId);
      const linked = accounts.find(a => a.accountEmail === 'pkceuser@organization.com');
      assert.ok(linked, 'Account must be persisted in database after OAuth callback');
      assert.equal(linked.accessToken, 'pkce-callback-access-tok');
      assert.equal(linked.refreshToken, 'pkce-callback-refresh-tok');

      await Db.deleteMSGraphAccount(linked.id);
    } finally {
      global.fetch = origFetch;
    }
  });

  // ---------------------------------------------------------------------------
  // Defect (d): Concurrency syncLock / in-flight guard and pushLocalEvent mutex
  // ---------------------------------------------------------------------------
  await t.test('Defect (d): POST /api/msgraph/accounts/:id/sync must reject concurrent requests with 409 Conflict (syncLock/inFlight)', async () => {
    // We launch two sync requests simultaneously
    const req1 = fetch(`${baseUrl}/api/msgraph/accounts/${account.id}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({ localEvents: [] })
    });

    const req2 = fetch(`${baseUrl}/api/msgraph/accounts/${account.id}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({ localEvents: [] })
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const statuses = [res1.status, res2.status].sort();

    // One request must succeed (200), and the concurrent request must be rejected with 409 Conflict
    assert.ok(statuses.includes(409), `Concurrent sync must be rejected with 409 Conflict. Got statuses: ${statuses.join(', ')}`);
  });

  await t.test('Defect (d): pushLocalEvent must guard against race condition using mutex/inFlight lock', async () => {
    const localEvent = {
      uid: 'concurrent-race-ev-1',
      title: 'Race Condition Test',
      start: '2026-10-20T10:00:00.000Z',
      end: '2026-10-20T11:00:00.000Z'
    };

    let postCount = 0;
    const mockFetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        postCount++;
        // Simulate network delay
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ id: 'graph-race-1', '@odata.etag': 'W/"race1"' })
        };
      }
      if (options.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'graph-race-1', '@odata.etag': 'W/"race2"' })
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    const engine = new MSGraphSyncEngine({ ...account, accessToken: 'valid-token', expiresAt: Date.now() + 3600000 }, mockFetch);

    // Call pushLocalEvent twice concurrently for the same event
    const [p1, p2] = await Promise.all([
      engine.pushLocalEvent(localEvent),
      engine.pushLocalEvent(localEvent)
    ]);

    assert.equal(postCount, 1, 'Only ONE POST must be issued to Graph to create the event; second must be synchronized');
    await Db.deleteMSGraphEventMapping('concurrent-race-ev-1');
  });
});
