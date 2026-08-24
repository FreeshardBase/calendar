'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3096';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { isNoOpEventSave, eventToICS } = require('../caldav/parser');

test('Issue #53 — Series Destruction & Recurrence Rule Preservation on No-Op Event Saves', async (t) => {
  const mockStore = new Map();
  let putCount = 0;

  const originalGet = CalDAVClient.prototype.get;
  const originalPut = CalDAVClient.prototype.put;

  CalDAVClient.prototype.get = async function(url) {
    if (mockStore.has(url)) {
      return mockStore.get(url);
    }
    const err = new Error('HTTP 404 Not Found');
    err.status = 404;
    throw err;
  };

  CalDAVClient.prototype.put = async function(url, ics, ifMatch) {
    putCount++;
    const etag = '"etag-v' + putCount + '"';
    const record = { ics, etag };
    mockStore.set(url, record);
    return record;
  };

  t.after(() => {
    CalDAVClient.prototype.get = originalGet;
    CalDAVClient.prototype.put = originalPut;
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  await t.test('isNoOpEventSave is re-exported from server/caldav/parser.js', () => {
    assert.equal(typeof isNoOpEventSave, 'function',
      'isNoOpEventSave must be exported from server/caldav/parser.js');
  });

  await t.test('PUT /api/events/:uid preserves existing ICS resource on CalDAV server when save is a no-op', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-53';
    await Db.upsertUser(testUserId, 'series53@example.com');

    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    assert.equal(authRes.status, 200);
    const cookie = authRes.headers.get('set-cookie').split(';')[0];
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    // 1. Pre-seed a recurring event with EXDATE in mockStore
    const uid = 'recurring-series-master-53';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'SUMMARY:Weekly Standup',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T093000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'EXDATE:20260908T090000Z',
      'DESCRIPTION:Sync meeting',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"initial-etag-1"' });
    putCount = 0;

    // 2. Perform PUT save with identical parameters (no-op save from frontend modal)
    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-1',
        title: 'Weekly Standup',
        start: '2026-09-01T09:00:00.000Z',
        end:   '2026-09-01T09:30:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=TU',
        description: 'Sync meeting'
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    const resData = await putRes.json();
    assert.equal(resData.title, 'Weekly Standup');

    // 3. Verify that CalDAVClient.prototype.put WAS NOT CALLED and original ICS is preserved with EXDATE intact
    assert.equal(putCount, 0, 'No-op save must NOT issue a PUT request to the CalDAV server');
    const storedRecord = mockStore.get(eventUrl);
    assert.ok(storedRecord.ics.includes('EXDATE:20260908T090000Z'),
      'Original EXDATE must be preserved in CalDAV store, preventing series destruction');
  });

  await t.test('PUT /api/events/:uid updates CalDAV server when save contains actual edits', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-53';

    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    const cookie = authRes.headers.get('set-cookie').split(';')[0];
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'edited-event-53';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'SUMMARY:Old Title',
      'DTSTART:20261001T100000Z',
      'DTEND:20261001T110000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"old-etag"' });
    putCount = 0;

    const editRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'old-etag',
        title: 'New Edited Title',
        start: '2026-10-01T10:00:00.000Z',
        end:   '2026-10-01T11:00:00.000Z',
        allDay: false
      })
    });

    assert.equal(editRes.status, 200);
    assert.equal(putCount, 1, 'Edited save MUST issue a PUT request to update CalDAV server');
    const storedRecord = mockStore.get(eventUrl);
    assert.ok(storedRecord.ics.includes('SUMMARY:New Edited Title'));
  });
});
