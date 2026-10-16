'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3301';
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
const { updateWholeSeries, parseAndExpandEvent, isNoOpEventSave } = require('../utils/ical');

test('Issue #79 — Editing a series from a later occurrence rewrites master DTSTART and deletes earlier occurrences', async (t) => {
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

  // The dialog's side (a series save from an occurrence sends its recurrenceId) is the
  // Playwright test "Issues #222 / #79" in e2e/calendar.spec.js.

  await t.test('2. updateWholeSeries preserves master DTSTART and all occurrences on title-only edit of later occurrence', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT','UID:series-79',
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');

    // Title-only edit of 3rd occurrence (2026-08-19)
    const eventData = {
      uid: 'series-79',
      title: 'Standup renamed',
      start: '2026-08-19T09:00:00.000Z',
      end: '2026-08-19T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=WE',
      startTimeZone: 'UTC',
      endTimeZone: 'UTC',
      recurrenceId: '2026-08-19T09:00:00Z'
    };

    const out = updateWholeSeries(existingIcs, eventData);
    const dtstartLine = out.split(/\r?\n/).find(l => /^DTSTART/.test(l));
    assert.ok(dtstartLine.includes('20260805T090000'), `DTSTART must remain 20260805, got: ${dtstartLine}`);

    const occurrences = parseAndExpandEvent(out, '2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z');
    assert.equal(occurrences.length, 6, `Expected 6 occurrences, got ${occurrences.length}`);
    assert.equal(occurrences[0].start, '2026-08-05T09:00:00.000Z');
    assert.equal(occurrences[1].start, '2026-08-12T09:00:00.000Z');
    assert.equal(occurrences[2].start, '2026-08-19T09:00:00.000Z');
    assert.equal(occurrences[2].title, 'Standup renamed');
  });

  await t.test('3. updateWholeSeries preserves master DTSTART when editing series from detached override occurrence', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT','UID:series-79-override',
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT',
      'BEGIN:VEVENT','UID:series-79-override',
      'RECURRENCE-ID:20260819T090000Z',
      'DTSTART:20260819T140000Z','DTEND:20260819T150000Z',
      'SUMMARY:Standup moved to afternoon',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Title-only edit of series from the detached 14:00 occurrence
    const eventData = {
      uid: 'series-79-override',
      title: 'Standup renamed across series',
      start: '2026-08-19T14:00:00.000Z',
      end: '2026-08-19T15:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=WE',
      startTimeZone: 'UTC',
      endTimeZone: 'UTC',
      recurrenceId: '2026-08-19T09:00:00Z'
    };

    const out = updateWholeSeries(existingIcs, eventData);
    const masterDtstart = out.split(/\r?\n/).find(l => /^DTSTART.*20260805/.test(l));
    assert.ok(masterDtstart, 'Master DTSTART must NOT be rewritten to exception time 14:00:00');
    assert.ok(out.includes('RECURRENCE-ID:20260819T090000Z'), 'Detached override RECURRENCE-ID must be preserved');
    assert.ok(out.includes('DTSTART:20260819T140000Z'), 'Detached override DTSTART must be preserved');
  });

  await t.test('4. updateWholeSeries shifts master DTSTART by delta when start time is shifted from later occurrence', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT','UID:series-79-shift',
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');

    // Shift 3rd occurrence by +1 hour (09:00 -> 10:00) with scope series
    const eventData = {
      uid: 'series-79-shift',
      title: 'Standup',
      start: '2026-08-19T10:00:00.000Z',
      end: '2026-08-19T11:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY;BYDAY=WE',
      startTimeZone: 'UTC',
      endTimeZone: 'UTC',
      recurrenceId: '2026-08-19T09:00:00Z'
    };

    const out = updateWholeSeries(existingIcs, eventData);
    const dtstartLine = out.split(/\r?\n/).find(l => /^DTSTART/.test(l));
    assert.ok(dtstartLine.includes('20260805T100000'), `Master DTSTART must shift to 10:00, got: ${dtstartLine}`);

    const occurrences = parseAndExpandEvent(out, '2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z');
    assert.equal(occurrences.length, 6, `Expected 6 occurrences, got ${occurrences.length}`);
    assert.equal(occurrences[0].start, '2026-08-05T10:00:00.000Z');
    assert.equal(occurrences[2].start, '2026-08-19T10:00:00.000Z');
  });

  await t.test('5. PUT /api/events/:uid with scope=series from later occurrence preserves master DTSTART and all occurrences (Clayde repro)', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-79';
    await Db.upsertUser(testUserId, 'series79@example.com');

    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'series-79-http';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT',`UID:${uid}`,
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"initial-etag-79"' });
    putCount = 0;

    // What the frontend sends when user edits 3rd occurrence and selects "Alle Termine der Serie"
    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-79',
        uid,
        title: 'Standup renamed',
        start: '2026-08-19T09:00:00.000Z',
        end: '2026-08-19T10:00:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        startTimeZone: 'UTC',
        endTimeZone: 'UTC',
        scope: 'series',
        recurrenceId: '2026-08-19T09:00:00Z'
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    const resData = await putRes.json();
    assert.equal(resData.start, '2026-08-05T09:00:00.000Z', 'Response start must reflect master DTSTART, not the opened occurrence');
    assert.equal(resData.recurrenceId, undefined, 'recurrenceId must not be present on whole-series master response');
    const storedRecord = mockStore.get(eventUrl);
    assert.ok(storedRecord, 'Event must be stored in CalDAV');
    
    // Check DTSTART in stored ICS
    const dtstartLine = storedRecord.ics.split(/\r?\n/).find(l => /^DTSTART/.test(l));
    assert.ok(
      dtstartLine.includes('20260805T090000'),
      `Master DTSTART must NOT be rewritten to 20260819! Got: ${dtstartLine}`
    );

    // Expand occurrences - all 6 must be present
    const occurrences = parseAndExpandEvent(storedRecord.ics, '2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z');
    assert.equal(occurrences.length, 6, `Expected 6 occurrences, got ${occurrences.length}. Earlier occurrences were deleted!`);
    assert.equal(occurrences[0].start, '2026-08-05T09:00:00.000Z');
    assert.equal(occurrences[1].start, '2026-08-12T09:00:00.000Z');
    assert.equal(occurrences[2].start, '2026-08-19T09:00:00.000Z');
  });

  await t.test('6. PUT /api/events/:uid with scope=series from detached override does not corrupt master DTSTART to exception time', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-79-override';
    await Db.upsertUser(testUserId, 'series79override@example.com');

    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'series-79-override-http';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT',`UID:${uid}`,
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT',
      'BEGIN:VEVENT',`UID:${uid}`,
      'RECURRENCE-ID:20260819T090000Z',
      'DTSTART:20260819T140000Z','DTEND:20260819T150000Z',
      'SUMMARY:Standup moved',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"initial-etag-79-ov"' });

    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-79-ov',
        uid,
        title: 'Standup renamed',
        start: '2026-08-19T14:00:00.000Z',
        end: '2026-08-19T15:00:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        startTimeZone: 'UTC',
        endTimeZone: 'UTC',
        scope: 'series',
        recurrenceId: '2026-08-19T09:00:00Z'
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    const storedRecord = mockStore.get(eventUrl);
    const masterDtstart = storedRecord.ics.split(/\r?\n/).find(l => /^DTSTART.*20260805/.test(l));
    assert.ok(masterDtstart, 'Master DTSTART must remain 20260805 and not become 14:00:00');
    assert.ok(storedRecord.ics.includes('DTSTART:20260819T140000Z'), 'Detached override must remain intact');
  });

  await t.test('7. PUT /api/events/:uid zero-edit save from occurrence with scope=series does not corrupt series', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-79-noop';
    await Db.upsertUser(testUserId, 'series79noop@example.com');

    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'series-79-noop-http';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN',
      'BEGIN:VEVENT',`UID:${uid}`,
      'DTSTART:20260805T090000Z','DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE','SUMMARY:Standup',
      'END:VEVENT','END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"initial-etag-79-noop"' });
    putCount = 0;

    // Zero-edit save from 3rd occurrence
    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-79-noop',
        uid,
        title: 'Standup',
        start: '2026-08-19T09:00:00.000Z',
        end: '2026-08-19T10:00:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        startTimeZone: 'UTC',
        endTimeZone: 'UTC',
        scope: 'series',
        recurrenceId: '2026-08-19T09:00:00Z'
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    const resData = await putRes.json();
    assert.equal(resData.start, '2026-08-05T09:00:00.000Z', 'No-op response start must reflect master DTSTART');
    assert.equal(resData.recurrenceId, undefined, 'recurrenceId must not be present on whole-series no-op master response');
    const storedRecord = mockStore.get(eventUrl);
    const occurrences = parseAndExpandEvent(storedRecord.ics, '2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z');
    assert.equal(occurrences.length, 6, 'Must preserve all 6 occurrences on zero-edit save');
  });
});
