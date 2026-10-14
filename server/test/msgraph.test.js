'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3094';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { graphEventToVEVENT, veventToGraphEvent, MSGraphSyncEngine } = require('../utils/msgraph');

test('MS Graph Calendar Sync Engine Suite', async (t) => {
  const { app, server } = require('../index');
  const { loginAs } = require('./helpers/testSession');

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';

  await t.test('Initial setup - authenticate session', async () => {
    sessionCookie = await loginAs('testuser-id');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.status, 200);
  });

  await t.test('graphEventToVEVENT should parse MS Graph event JSON correctly', () => {
    const graphEvent = {
      id: 'graph-123',
      subject: 'Outlook Strategy Sync',
      body: { content: '<p>Discussion about <b>Q4 Goals</b></p>', contentType: 'html' },
      start: { dateTime: '2026-09-10T10:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-10T11:30:00.0000000', timeZone: 'UTC' },
      location: { displayName: 'Microsoft Teams Meeting' },
      attendees: [
        { emailAddress: { name: 'Test User', address: 'testuser@example.com' }, status: { response: 'accepted' } }
      ],
      '@odata.etag': 'W/"etag123"'
    };

    const vevent = graphEventToVEVENT(graphEvent);
    assert.ok(vevent);
    assert.equal(vevent.uid, 'msgraph-event-graph-123');
    assert.equal(vevent.title, 'Outlook Strategy Sync');
    assert.equal(vevent.description, 'Discussion about Q4 Goals');
    assert.equal(vevent.location, 'Microsoft Teams Meeting');
    assert.equal(vevent.attendees.length, 1);
    assert.equal(vevent.attendees[0].email, 'testuser@example.com');
    assert.equal(vevent.attendees[0].status, 'ACCEPTED');
    assert.equal(vevent.eTag, 'W/"etag123"');
  });

  await t.test('veventToGraphEvent should convert local event to MS Graph JSON format', () => {
    const localEvent = {
      uid: 'local-ev-456',
      title: 'Local Standup',
      description: 'Daily dev alignment',
      start: '2026-09-15T09:00:00.000Z',
      end: '2026-09-15T09:30:00.000Z',
      location: 'Room 101',
      attendees: [
        { name: 'Test User', email: 'testuser@example.com', status: 'ACCEPTED' }
      ]
    };

    const graphPayload = veventToGraphEvent(localEvent);
    assert.ok(graphPayload);
    assert.equal(graphPayload.subject, 'Local Standup');
    assert.equal(graphPayload.body.content, 'Daily dev alignment');
    assert.equal(graphPayload.location.displayName, 'Room 101');
    assert.equal(graphPayload.start.dateTime, '2026-09-15T09:00:00');
    assert.equal(graphPayload.attendees[0].emailAddress.address, 'testuser@example.com');
  });

  await t.test('Database MS Graph account persistence lifecycle', async () => {
    const userId = 'testuser-id';
    const account = await Db.addMSGraphAccount({
      userId,
      accountEmail: 'testuser@example.com',
      tenantId: 'common',
      clientId: 'client-id-123',
      accessToken: 'access-123',
      refreshToken: 'refresh-123'
    });

    assert.ok(account.id);
    assert.equal(account.accountEmail, 'testuser@example.com');

    const accounts = await Db.getMSGraphAccounts(userId);
    assert.ok(accounts.length >= 1);
    const fetched = accounts.find(a => a.id === account.id);
    assert.ok(fetched);
    assert.equal(fetched.accountEmail, 'testuser@example.com');

    await Db.updateMSGraphAccount(account.id, { deltaLink: 'https://graph.microsoft.com/delta-link-1' });
    const updated = await Db.getMSGraphAccountById(account.id);
    assert.equal(updated.deltaLink, 'https://graph.microsoft.com/delta-link-1');

    await Db.upsertMSGraphEventMapping('local-1', 'graph-1', account.id, 'etag-1');
    const mapping = await Db.getMSGraphEventMapping('local-1');
    assert.ok(mapping);
    assert.equal(mapping.graphId, 'graph-1');

    await Db.deleteMSGraphAccount(account.id);
    const deleted = await Db.getMSGraphAccountById(account.id);
    assert.equal(deleted, null);
  });

  await t.test('MSGraphSyncEngine bidirectional sync — asserts actual CalDAV writes, not just bookkeeping count (issue #98)', async () => {
    const account = await Db.addMSGraphAccount({
      userId: 'testuser-id',
      accountEmail: 'testuser@example.com',
      accessToken: 'valid-token',
      refreshToken: 'valid-refresh'
    });

    // Track actual CalDAV writes — not just syncedCount bookkeeping rows
    const caldavWritten = new Map();
    const mockCalDAVClient = {
      put: async (url, icsData) => {
        caldavWritten.set(url, icsData);
        return { status: 201, etag: '"etag-test"' };
      },
      delete: async () => true
    };

    const mockFetch = async (url, options = {}) => {
      if (url.includes('/events') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            id: `pushed-graph-${Date.now()}`,
            subject: body.subject,
            '@odata.etag': 'W/"pushedEtag"'
          })
        };
      }
      // Delta events endpoint response
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'remote-graph-999',
              subject: 'Remote Outlook Event',
              body: { content: 'Remote details' },
              start: { dateTime: '2026-09-20T14:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-09-20T15:00:00.0000000', timeZone: 'UTC' }
            }
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/deltaToken123'
        })
      };
    };

    const targetCalendarUrl = 'http://localhost:1080/users/testuser-id/calendars/personal';
    const engine = new MSGraphSyncEngine(account, mockFetch, mockCalDAVClient, targetCalendarUrl);
    const localEvents = [
      {
        uid: 'local-unmapped-ev-1',
        title: 'Local Planning Session',
        start: '2026-09-21T09:00:00.000Z',
        end: '2026-09-21T10:00:00.000Z'
      }
    ];

    const result = await engine.sync(localEvents);
    assert.ok(result);
    assert.equal(result.accountId, account.id);
    // Verify ≥2 sync actions (1 remote upserted + 1 local pushed)
    assert.ok(result.syncedCount >= 2, `syncedCount should be ≥ 2, got ${result.syncedCount}`);

    // Critical: verify the remote event was actually written to CalDAV (not just bookkeeping)
    const expectedCalDAVUrl = `${targetCalendarUrl}/msgraph-event-remote-graph-999.ics`;
    assert.ok(
      caldavWritten.has(expectedCalDAVUrl),
      `CalDAV put() must be called for remote event at ${expectedCalDAVUrl}`
    );
    const writtenICS = caldavWritten.get(expectedCalDAVUrl);
    assert.ok(writtenICS.includes('SUMMARY:Remote Outlook Event'), 'Written ICS must contain the event title');
    assert.ok(writtenICS.includes('BEGIN:VEVENT'), 'Written ICS must be a valid VEVENT');

    // Clean up
    await Db.deleteMSGraphEventMapping('msgraph-event-remote-graph-999');
    await Db.deleteMSGraphEventMapping('local-unmapped-ev-1');
    await Db.deleteMSGraphAccount(account.id);
  });

  await t.test('REST API POST & GET /api/msgraph/accounts', async () => {
    const resPost = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie
      },
      body: JSON.stringify({
        accountEmail: 'testuser@example.com',
        tenantId: 'common',
        clientId: 'client-abc'
      })
    });
    assert.equal(resPost.status, 201);
    const postData = await resPost.json();
    assert.ok(postData.success);
    const createdAccountId = postData.account.id;

    const resGet = await fetch(`${baseUrl}/api/msgraph/accounts`, {
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(resGet.status, 200);
    const getData = await resGet.json();
    assert.ok(getData.accounts.some(a => a.id === createdAccountId));

    const resDel = await fetch(`${baseUrl}/api/msgraph/accounts/${createdAccountId}`, {
      method: 'DELETE',
      headers: {
        'Cookie': sessionCookie
      }
    });
    assert.equal(resDel.status, 200);
  });
});
