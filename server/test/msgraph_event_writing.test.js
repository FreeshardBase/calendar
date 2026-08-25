'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { MSGraphSyncEngine } = require('../utils/msgraph');

test('Issue #60 — MS Graph Sync Event Data Persistence', async (t) => {
  const account = await Db.addMSGraphAccount({
    userId: 'msgraph-write-test-user',
    accountEmail: 'msgraph-write@example.com',
    accessToken: 'valid-token',
    refreshToken: 'valid-refresh'
  });

  t.after(async () => {
    await Db.deleteMSGraphAccount(account.id);
  });

  await t.test('sync should write event data via CalDAV client when caldavClient is provided', async () => {
    const writtenEvents = new Map();
    const deletedEvents = new Set();

    const mockCalDAVClient = {
      put: async (url, icsData) => {
        writtenEvents.set(url, icsData);
        return { status: 201, etag: '"etag-123"' };
      },
      delete: async (url) => {
        deletedEvents.add(url);
        return true;
      }
    };

    const mockFetch = async (url) => {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'graph-write-event-1',
              subject: 'Persisted MS Graph Event',
              body: { content: 'This event should actually be written to CalDAV' },
              start: { dateTime: '2026-10-01T10:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-10-01T11:00:00.0000000', timeZone: 'UTC' }
            }
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta-written'
        })
      };
    };

    const targetCalendarUrl = 'http://localhost:1080/users/msgraph-write-test-user/calendars/personal';
    const engine = new MSGraphSyncEngine(account, mockFetch, mockCalDAVClient, targetCalendarUrl);

    const result = await engine.sync([]);
    assert.ok(result);
    assert.equal(result.syncedCount, 1);

    const expectedUrl = `${targetCalendarUrl}/msgraph-event-graph-write-event-1.ics`;
    assert.ok(writtenEvents.has(expectedUrl), 'Event ICS data must be written to CalDAV store');

    const icsContent = writtenEvents.get(expectedUrl);
    assert.ok(icsContent.includes('SUMMARY:Persisted MS Graph Event'), 'ICS data must contain event summary');
    assert.ok(icsContent.includes('BEGIN:VEVENT'), 'ICS data must contain VEVENT');

    // Clean up mapping
    await Db.deleteMSGraphEventMapping('msgraph-event-graph-write-event-1');
  });

  await t.test('sync should handle remote deletion by deleting event from CalDAV client', async () => {
    const deletedEvents = new Set();
    const localUid = 'msgraph-event-graph-delete-1';
    const graphId = 'graph-delete-1';

    await Db.upsertMSGraphEventMapping(localUid, graphId, account.id, 'etag-delete');

    const mockCalDAVClient = {
      put: async () => ({ status: 201 }),
      delete: async (url) => {
        deletedEvents.add(url);
        return true;
      }
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        value: [
          { id: graphId, '@removed': { reason: 'deleted' } }
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta-deleted'
      })
    });

    const targetCalendarUrl = 'http://localhost:1080/users/msgraph-write-test-user/calendars/personal';
    const engine = new MSGraphSyncEngine(account, mockFetch, mockCalDAVClient, targetCalendarUrl);

    const result = await engine.sync([]);
    assert.ok(result);

    const expectedUrl = `${targetCalendarUrl}/${localUid}.ics`;
    assert.ok(deletedEvents.has(expectedUrl), 'Deleted remote event must be deleted from CalDAV store');

    const mapping = await Db.getMSGraphEventMappingByGraphId(graphId);
    assert.equal(mapping, null, 'Mapping row must be deleted');
  });
});
