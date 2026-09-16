'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3296';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { isNoOpEventSave, parseICSToEvent, upsertOccurrenceOverride } = require('../caldav/parser');

test('Issue #296 — Zero-Edit Occurrence Save & Detached Override Recurrence-ID Drift Prevention', async (t) => {
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

  // Recurring series in Europe/Berlin starting at 12:00 local time (10:00 UTC in May CEST)
  const tzBerlinIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:series-296-berlin',
    'SUMMARY:Weekly Berlin Sync',
    'DTSTART;TZID=Europe/Berlin:20260515T120000',
    'DTEND;TZID=Europe/Berlin:20260515T130000',
    'RRULE:FREQ=WEEKLY',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  // Occurrence 1: 2026-05-15 12:00 Berlin = 2026-05-15T10:00:00.000Z
  const recurrenceIdUtc = '20260515T100000Z';
  const recurrenceIdIso = '2026-05-15T10:00:00.000Z';

  const uneditedOccurrenceData = {
    uid: 'series-296-berlin::20260515T100000Z',
    title: 'Weekly Berlin Sync',
    start: '2026-05-15T10:00:00.000Z',
    end: '2026-05-15T11:00:00.000Z',
    allDay: false,
    recurrence: 'FREQ=WEEKLY',
    startTimeZone: 'Europe/Berlin',
    endTimeZone: 'Europe/Berlin'
  };

  const editedOccurrenceData = {
    ...uneditedOccurrenceData,
    title: 'Weekly Berlin Sync (Special Topic)'
  };

  await t.test('isNoOpEventSave identifies unedited occurrence as no-op when no detached override exists', () => {
    assert.equal(
      isNoOpEventSave(tzBerlinIcs, uneditedOccurrenceData, recurrenceIdIso),
      true,
      'isNoOpEventSave MUST return true for unedited occurrence derived from master series'
    );
  });

  await t.test('isNoOpEventSave returns false when occurrence payload contains modified title', () => {
    assert.equal(
      isNoOpEventSave(tzBerlinIcs, editedOccurrenceData, recurrenceIdIso),
      false,
      'isNoOpEventSave MUST return false when occurrence properties are edited'
    );
  });

  await t.test('upsertOccurrenceOverride produces matching RECURRENCE-ID in master timezone without shifting offset', () => {
    const overrideIcs = upsertOccurrenceOverride(tzBerlinIcs, recurrenceIdIso, editedOccurrenceData);
    assert.ok(overrideIcs.includes('RECURRENCE-ID;TZID=Europe/Berlin:20260515T120000'),
      'RECURRENCE-ID must be set to 20260515T120000 Europe/Berlin (matching master start time)');
    assert.ok(!overrideIcs.includes('RECURRENCE-ID;TZID=Europe/Berlin:20260515T100000'),
      'RECURRENCE-ID must NOT be shifted to 20260515T100000 Berlin (which would be -2h offset drift)');
  });

  await t.test('Multiple consecutive zero-edit saves do NOT drift RECURRENCE-ID or DTSTART', () => {
    let currentIcs = upsertOccurrenceOverride(tzBerlinIcs, recurrenceIdIso, editedOccurrenceData);
    const parsed1 = parseICSToEvent(currentIcs, { recurrenceId: recurrenceIdIso });
    assert.equal(parsed1.title, 'Weekly Berlin Sync (Special Topic)');

    // Save again 3 times with same event data
    for (let i = 0; i < 3; i++) {
      currentIcs = upsertOccurrenceOverride(currentIcs, recurrenceIdIso, editedOccurrenceData);
    }

    assert.ok(currentIcs.includes('RECURRENCE-ID;TZID=Europe/Berlin:20260515T120000'),
      'RECURRENCE-ID must remain stable across multiple saves');
    assert.ok(currentIcs.includes('DTSTART;TZID=Europe/Berlin:20260515T120000'),
      'DTSTART must remain stable across multiple saves');
  });

  await t.test('PUT /api/events/:uid with scope=occurrence returns 200 OK without CalDAV PUT on zero-edit save', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'user-issue-296';
    await Db.upsertUser(testUserId, 'user296@example.com');

    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    assert.equal(authRes.status, 200);
    const cookie = authRes.headers.get('set-cookie').split(';')[0];
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'series-296-berlin';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;

    mockStore.set(eventUrl, { ics: tzBerlinIcs, etag: '"etag-296"' });
    putCount = 0;

    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'etag-296',
        scope: 'occurrence',
        recurrenceId: recurrenceIdIso,
        ...uneditedOccurrenceData
      })
    });

    assert.equal(putRes.status, 200, 'Zero-edit occurrence save MUST return 200 OK');
    assert.equal(putCount, 0, 'Zero-edit occurrence save MUST NOT issue CalDAV PUT or manufacture detached override');
  });
});
