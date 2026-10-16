'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3143';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
server.listen(process.env.PORT);
const { loginAs } = require('./helpers/testSession');
const { isNoOpEventSave, updateWholeSeries, parseAndExpandEvent, parseICSToEvent } = require('../caldav/parser');

test('Issue #243 — Series Preservation & Detached Override Orphaning Prevention (Fix #53 + #79 Coherence)', async (t) => {
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

  await Db.clearAll();

  const testUid = 'series-243-uid';
  const initialIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar//EN',
    'BEGIN:VEVENT',
    `UID:${testUid}`,
    'SUMMARY:Weekly Team Sync',
    'DTSTART:20260901T090000Z',
    'DTEND:20260901T100000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=TU',
    'EXDATE:20260908T090000Z',
    'DESCRIPTION:Project Status Update',
    'LOCATION:Conference Room A',
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:${testUid}`,
    'RECURRENCE-ID:20260915T090000Z',
    'SUMMARY:Detached One-off Meeting',
    'DTSTART:20260915T110000Z',
    'DTEND:20260915T120000Z',
    'DESCRIPTION:Rescheduled instance',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  await t.test('isNoOpEventSave and updateWholeSeries are correctly exported', () => {
    assert.equal(typeof isNoOpEventSave, 'function', 'isNoOpEventSave must be exported');
    assert.equal(typeof updateWholeSeries, 'function', 'updateWholeSeries must be exported');
  });

  await t.test('zero-edit save detects no-op and preserves full ICS verbatim without network PUT', () => {
    const masterObj = parseICSToEvent(initialIcs);
    assert.ok(masterObj, 'must parse master event object');

    const isNoOp = isNoOpEventSave(initialIcs, masterObj);
    assert.equal(isNoOp, true, 'Zero-edit save must be identified as no-op to prevent unnecessary PUT and series alteration');
  });

  await t.test('non-zero-edit whole-series update preserves EXDATE and detached overrides without orphaning', () => {
    const updatedTitle = 'Weekly Team Sync (Updated)';
    const updatedIcs = updateWholeSeries(initialIcs, {
      uid: testUid,
      title: updatedTitle,
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=TU',
      description: 'Project Status Update',
      location: 'Conference Room A'
    });

    assert.ok(updatedIcs.includes(`SUMMARY:${updatedTitle}`), 'Master title must be updated');
    assert.ok(updatedIcs.includes('EXDATE:20260908T090000Z'), 'EXDATE must be preserved on master VEVENT');
    assert.ok(updatedIcs.includes('RECURRENCE-ID:20260915T090000Z'), 'Detached override VEVENT subcomponent must NOT be orphaned');
    assert.ok(updatedIcs.includes('SUMMARY:Detached One-off Meeting'), 'Detached override SUMMARY must remain intact');

    const occurrences = parseAndExpandEvent(updatedIcs, '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z');
    assert.ok(occurrences.length >= 4, 'Expanded occurrences should include master recurrence and detached override');
    const detached = occurrences.find(o => o.recurrenceId === '2026-09-15T09:00:00Z' || o.title === 'Detached One-off Meeting');
    assert.ok(detached, 'Detached override instance must exist in expanded occurrence set');
  });

  await t.test('PUT /api/events/:uid executes no-op bypass when unchanged and updates whole series cleanly when edited', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-user-243';
    await Db.upsertUser(testUserId, 'user243@example.com');

    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${testUid}.ics`;

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"etag-243-1"' });
    putCount = 0;

    // 1. Zero-edit PUT request (No-op)
    const noopRes = await fetch(`${baseUrl}/api/events/${testUid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${testUid}.ics`,
        etag: 'etag-243-1',
        title: 'Weekly Team Sync',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=TU',
        description: 'Project Status Update',
        location: 'Conference Room A'
      })
    });

    assert.equal(noopRes.status, 200, 'No-op PUT request must succeed with HTTP 200');
    assert.equal(putCount, 0, 'No-op PUT request must NOT make CalDAV PUT call');
    assert.equal(mockStore.get(eventUrl).ics, initialIcs, 'Stored ICS must be unchanged');

    // 2. Non-zero-edit PUT request (Edit title)
    const editRes = await fetch(`${baseUrl}/api/events/${testUid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${testUid}.ics`,
        etag: 'etag-243-1',
        title: 'Weekly Team Sync (Renamed)',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=TU',
        description: 'Project Status Update',
        location: 'Conference Room A'
      })
    });

    assert.equal(editRes.status, 200, 'Edit PUT request must succeed');
    assert.equal(putCount, 1, 'Edit PUT request must make CalDAV PUT call');

    const storedRecord = mockStore.get(eventUrl);
    assert.ok(storedRecord.ics.includes('SUMMARY:Weekly Team Sync (Renamed)'), 'Stored ICS must have new summary');
    assert.ok(storedRecord.ics.includes('EXDATE:20260908T090000Z'), 'Stored ICS must preserve EXDATE');
    assert.ok(storedRecord.ics.includes('RECURRENCE-ID:20260915T090000Z'), 'Stored ICS must preserve detached RECURRENCE-ID subcomponent');
  });
});
