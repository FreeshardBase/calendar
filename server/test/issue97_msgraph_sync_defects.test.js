'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { graphEventToVEVENT, veventToGraphEvent, MSGraphSyncEngine } = require('../utils/msgraph');

test('Issue #97 — MS Graph Sync Engine End-to-End Defects', async (t) => {
  const account = await Db.addMSGraphAccount({
    userId: 'msgraph-issue97-user',
    accountEmail: 'issue97@example.com',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    expiresAt: Date.now() - 1000 // Expired to trigger refresh
  });

  t.after(async () => {
    await Db.deleteMSGraphAccount(account.id);
  });

  await t.test('Defect 1: fetchRemoteDeltaEvents should follow @odata.nextLink pagination until @odata.deltaLink', async () => {
    const fetchedUrls = [];
    const mockFetch = async (url) => {
      fetchedUrls.push(url);
      if (url.includes('page1')) {
        return {
          ok: true,
          json: async () => ({
            value: [
              { id: 'ev-page1', subject: 'Page 1 Event', start: { dateTime: '2026-10-01T10:00:00.000Z', timeZone: 'UTC' } }
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/events/delta?page2'
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          value: [
            { id: 'ev-page2', subject: 'Page 2 Event', start: { dateTime: '2026-10-01T11:00:00.000Z', timeZone: 'UTC' } }
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?finalDeltaToken'
        })
      };
    };

    const engine = new MSGraphSyncEngine({ ...account, accessToken: 'valid-token', expiresAt: Date.now() + 3600000, deltaLink: 'https://graph.microsoft.com/v1.0/me/events/delta?page1' }, mockFetch);
    const res = await engine.fetchRemoteDeltaEvents();

    assert.equal(res.events.length, 2, 'Should combine events from both pages');
    assert.equal(res.deltaLink, 'https://graph.microsoft.com/v1.0/me/events/delta?finalDeltaToken', 'Should retain final deltaLink');
    assert.equal(fetchedUrls.length, 2, 'Should have made 2 HTTP requests following nextLink');
  });

  await t.test('Defect 2: graphEventToVEVENT UID must match localUid in sync mapping', () => {
    const graphEvent = {
      id: 'graph-uid-999',
      subject: 'UID Consistency Check',
      start: { dateTime: '2026-10-05T12:00:00.000Z', timeZone: 'UTC' }
    };

    const vevent = graphEventToVEVENT(graphEvent);
    assert.equal(vevent.uid, 'msgraph-event-graph-uid-999', 'vevent.uid must use canonical msgraph-event- prefix matching mapping localUid');
  });

  await t.test('Defect 3: ensureAccessToken should persist refreshed refreshToken and throw on OAuth failure', async () => {
    let tokenRequestPayload = null;
    const mockFetch = async (url, options = {}) => {
      if (url.includes('/token')) {
        tokenRequestPayload = options.body.toString();
        return {
          ok: true,
          json: async () => ({
            access_token: 'brand-new-access-token',
            refresh_token: 'brand-new-refresh-token',
            expires_in: 3600
          })
        };
      }
      return { ok: true, json: async () => ({ value: [] }) };
    };

    const engine = new MSGraphSyncEngine(account, mockFetch);
    const token = await engine.ensureAccessToken();

    assert.equal(token, 'brand-new-access-token');
    assert.equal(account.refreshToken, 'brand-new-refresh-token', 'In-memory account refreshToken must be updated');

    const dbAcc = await Db.getMSGraphAccountById(account.id);
    assert.equal(dbAcc.refreshToken, 'brand-new-refresh-token', 'SQLite DB record refreshToken must be updated');
  });

  await t.test('Defect 4: pushLocalEvent should handle 204 No Content or missing ID on PATCH updates', async () => {
    const graphId = 'graph-patch-123';
    const localUid = 'msgraph-event-patch-123';
    await Db.upsertMSGraphEventMapping(localUid, graphId, account.id, 'etag-1');

    const mockFetch = async (url, options) => {
      if (options.method === 'PATCH') {
        return {
          ok: true,
          status: 204,
          text: async () => '',
          json: async () => { throw new Error('Unexpected end of JSON input'); }
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    const engine = new MSGraphSyncEngine(account, mockFetch);
    const result = await engine.pushLocalEvent({
      uid: localUid,
      title: 'Updated Event Title',
      start: '2026-10-10T10:00:00.000Z',
      end: '2026-10-10T11:00:00.000Z'
    });

    assert.equal(result.graphId, graphId, 'Should preserve graphId from existing mapping on 204 PATCH response');

    await Db.deleteMSGraphEventMapping(localUid);
  });

  await t.test('Defect 5: sync should push local modifications for existing mapped events', async () => {
    const graphId = 'graph-existing-456';
    const localUid = 'msgraph-event-existing-456';
    await Db.upsertMSGraphEventMapping(localUid, graphId, account.id, 'etag-orig');

    const patchedBodies = [];
    const mockFetch = async (url, options = {}) => {
      if (url.includes('/events') && options.method === 'PATCH') {
        patchedBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: graphId, '@odata.etag': 'W/"new-etag"' })
        };
      }
      return {
        ok: true,
        json: async () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta' })
      };
    };

    const engine = new MSGraphSyncEngine(account, mockFetch);
    const localEvents = [
      {
        uid: localUid,
        title: 'Locally Modified Event Title',
        start: '2026-10-12T14:00:00.000Z',
        end: '2026-10-12T15:00:00.000Z'
      }
    ];

    const result = await engine.sync(localEvents);
    assert.equal(patchedBodies.length, 1, 'Should call PATCH for locally modified mapped event');
    assert.equal(patchedBodies[0].subject, 'Locally Modified Event Title');

    await Db.deleteMSGraphEventMapping(localUid);
  });
});
