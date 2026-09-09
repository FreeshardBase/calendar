'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3138';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { isNoOpEventSave, updateWholeSeries, parseICSToEvent, parseAndExpandEvent } = require('../caldav/parser');

test('Issue #238 — No-Op Save on Recurring Event Preserves Stored Bytes, EXDATE, Overrides and Timezones', async (t) => {
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

  const recurringIcsWithAllFeatures = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FreeShard//WebCalendar//EN',
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
    'UID:recurring-238-master',
    'SUMMARY:Weekly Team Sync',
    'DESCRIPTION:Weekly status sync',
    'LOCATION:Room 404',
    'DTSTART;TZID=Europe/Berlin:20260901T100000',
    'DTEND;TZID=Europe/Berlin:20260901T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=1',
    'EXDATE;TZID=Europe/Berlin:20260908T100000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:recurring-238-master',
    'RECURRENCE-ID;TZID=Europe/Berlin:20260915T100000',
    'SUMMARY:Special Team Sync (Moved)',
    'DTSTART;TZID=Europe/Berlin:20260915T140000',
    'DTEND;TZID=Europe/Berlin:20260915T150000',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  await t.test('isNoOpEventSave recognizes zero-edit payload on complex recurring event', () => {
    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);
    assert.ok(parsedEvent, 'parseICSToEvent must successfully parse recurring ICS');

    const incomingPayload = {
      uid: parsedEvent.uid,
      title: parsedEvent.title,
      start: parsedEvent.start,
      end: parsedEvent.end,
      allDay: parsedEvent.allDay,
      location: parsedEvent.location,
      description: parsedEvent.description,
      recurrence: parsedEvent.recurrence
    };

    const isNoOp = isNoOpEventSave(recurringIcsWithAllFeatures, incomingPayload);
    assert.equal(isNoOp, true, 'isNoOpEventSave must return true for identical recurring event payload');
  });

  await t.test('PUT /api/events/:uid with no-op recurring payload short-circuits without CalDAV PUT call', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-user-238';
    await Db.upsertUser(testUserId, 'user238@example.com');

    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    assert.equal(authRes.status, 200);
    const cookie = authRes.headers.get('set-cookie').split(';')[0];
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'recurring-238-master';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;

    mockStore.set(eventUrl, { ics: recurringIcsWithAllFeatures, etag: '"initial-etag-238"' });
    putCount = 0;

    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);

    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-238',
        title: parsedEvent.title,
        start: parsedEvent.start,
        end: parsedEvent.end,
        allDay: parsedEvent.allDay,
        location: parsedEvent.location,
        description: parsedEvent.description,
        recurrence: parsedEvent.recurrence
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    assert.equal(putCount, 0, 'No-op save MUST short-circuit and NOT call CalDAV PUT');

    const storedRecord = mockStore.get(eventUrl);
    assert.equal(storedRecord.ics, recurringIcsWithAllFeatures, 'Stored ICS bytes must remain completely untouched');
  });

  await t.test('updateWholeSeries preserves EXDATE, detached overrides, VTIMEZONE, and RRULE without drift', () => {
    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);
    const updatedPayload = {
      ...parsedEvent,
      title: 'Weekly Team Sync (Updated Title)'
    };

    const updatedIcs = updateWholeSeries(recurringIcsWithAllFeatures, updatedPayload);

    assert.ok(updatedIcs.includes('SUMMARY:Weekly Team Sync (Updated Title)'), 'Updated title must be present');
    assert.ok(updatedIcs.includes('EXDATE'), 'EXDATE must be preserved');
    assert.ok(updatedIcs.includes('SUMMARY:Special Team Sync (Moved)'), 'Detached override VEVENT summary must be preserved');
    assert.ok(updatedIcs.includes('RECURRENCE-ID'), 'Detached RECURRENCE-ID must be preserved');
    assert.ok(updatedIcs.includes('TZID:Europe/Berlin'), 'VTIMEZONE TZID must be preserved');
    assert.ok(updatedIcs.includes('RRULE:FREQ=WEEKLY'), 'RRULE must be preserved');

    assert.doesNotMatch(updatedIcs, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/, 'Must not mix TZID with Z suffix on DTSTART');
    assert.doesNotMatch(updatedIcs, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/, 'Must not mix TZID with Z suffix on DTEND');
  });
});
