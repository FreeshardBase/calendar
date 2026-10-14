'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3126';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { updateWholeSeries, parseAndExpandEvent } = require('../caldav/parser');

test('Issue #241 — Whole-Series Save EXDATE and Detached Override Preservation', async (t) => {
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

  t.before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT, resolve));
    }
  });

  t.after(() => {
    CalDAVClient.prototype.get = originalGet;
    CalDAVClient.prototype.put = originalPut;
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  await t.test('updateWholeSeries is re-exported from server/caldav/parser.js', () => {
    assert.equal(typeof updateWholeSeries, 'function',
      'updateWholeSeries must be exported from server/caldav/parser.js');
  });

  await t.test('updateWholeSeries preserves EXDATE and detached overrides on whole-series edit', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-241-unit',
      'SUMMARY:Original Weekly Meeting',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'RRULE:FREQ=WEEKLY',
      'EXDATE:20260908T090000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-241-unit',
      'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Detached Instance Meeting',
      'DTSTART:20260915T110000Z',
      'DTEND:20260915T120000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateWholeSeries(originalIcs, {
      uid: 'series-241-unit',
      title: 'Renamed Master Meeting',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY'
    });

    assert.ok(updatedIcs.includes('SUMMARY:Renamed Master Meeting'), 'Updated master title must be present');
    assert.ok(updatedIcs.includes('EXDATE:20260908T090000Z'), 'EXDATE must be preserved');
    assert.ok(updatedIcs.includes('SUMMARY:Detached Instance Meeting'), 'Detached override VEVENT summary must be preserved');
    assert.ok(updatedIcs.includes('RECURRENCE-ID:20260915T090000Z'), 'Detached RECURRENCE-ID must be preserved');

    const instances = parseAndExpandEvent(updatedIcs, '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z');
    assert.equal(instances.length, 4, 'Must expand to 4 instances (one EXDATE excluded)');
  });

  await t.test('updateWholeSeries correctly identifies master VEVENT when detached override appears first in ICS', () => {
    const reversedIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-reversed-order',
      'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Detached Override First',
      'DTSTART:20260915T110000Z',
      'DTEND:20260915T120000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-reversed-order',
      'SUMMARY:Master Event Second',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'RRULE:FREQ=WEEKLY',
      'EXDATE:20260908T090000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateWholeSeries(reversedIcs, {
      uid: 'series-reversed-order',
      title: 'Renamed Master Series',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY'
    });

    assert.ok(updatedIcs.includes('SUMMARY:Renamed Master Series'), 'Master event summary must be updated');
    assert.ok(updatedIcs.includes('SUMMARY:Detached Override First'), 'Detached override summary must be untouched');
    assert.ok(updatedIcs.includes('RECURRENCE-ID:20260915T090000Z'), 'Detached RECURRENCE-ID must be preserved');
  });

  await t.test('updateWholeSeries preserves multiple EXDATE properties and VTIMEZONE blocks', () => {
    const multiExdateIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:STANDARD',
      'DTSTART:19701025T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:series-multi-exdate',
      'SUMMARY:Multi Exdate Master',
      'DTSTART;TZID=Europe/Berlin:20260901T090000',
      'DTEND;TZID=Europe/Berlin:20260901T100000',
      'RRULE:FREQ=WEEKLY',
      'EXDATE;TZID=Europe/Berlin:20260908T090000',
      'EXDATE;TZID=Europe/Berlin:20260922T090000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateWholeSeries(multiExdateIcs, {
      uid: 'series-multi-exdate',
      title: 'Updated Multi Exdate Master',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY'
    });

    assert.ok(updatedIcs.includes('SUMMARY:Updated Multi Exdate Master'), 'Title must update');
    // 09:00Z is 11:00 Berlin summer time, so the save moves the series
    // by two hours and both exceptions move with it (#243).
    assert.ok(updatedIcs.includes('DTSTART;TZID=Europe/Berlin:20260901T110000'), 'Series start moves to 11:00');
    assert.ok(updatedIcs.includes('EXDATE;TZID=Europe/Berlin:20260908T110000'), 'First EXDATE must be preserved and follow DTSTART');
    assert.ok(updatedIcs.includes('EXDATE;TZID=Europe/Berlin:20260922T110000'), 'Second EXDATE must be preserved and follow DTSTART');
    assert.ok(updatedIcs.includes('BEGIN:VTIMEZONE'), 'VTIMEZONE component must be preserved');
    assert.ok(updatedIcs.includes('TZID:Europe/Berlin'), 'VTIMEZONE tzid must be preserved');
  });

  await t.test('updateWholeSeries handles empty or whitespace existingIcs safely', () => {
    const fallbackIcs = updateWholeSeries('   ', {
      uid: 'fallback-uid',
      title: 'Fallback Event',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z'
    });
    assert.ok(fallbackIcs.includes('SUMMARY:Fallback Event'));
    assert.ok(fallbackIcs.includes('UID:fallback-uid'));

    const nullFallback = updateWholeSeries(null, {
      uid: 'null-uid',
      title: 'Null Fallback Event',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z'
    });
    assert.ok(nullFallback.includes('SUMMARY:Null Fallback Event'));
  });

  await t.test('updateWholeSeries kills mutant when only detached VEVENT is present in existingIcs', () => {
    const detachedOnlyIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:detached-only-series',
      'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Detached Instance Only',
      'DTSTART:20260915T110000Z',
      'DTEND:20260915T120000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateWholeSeries(detachedOnlyIcs, {
      uid: 'detached-only-series',
      title: 'Updated Master Title',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false
    });

    assert.ok(updatedIcs.includes('RECURRENCE-ID:20260915T090000Z'), 'Detached RECURRENCE-ID must be preserved when no master VEVENT is present');
  });

  await t.test('updateWholeSeries preserves all VEVENT subcomponents and kills vevent subcomponent query mutant', () => {
    const multiVeventIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:multi-vevent-series',
      'SUMMARY:Master Event',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'RRULE:FREQ=WEEKLY',
      'EXDATE:20260908T090000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:multi-vevent-series',
      'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Override Instance 1',
      'DTSTART:20260915T110000Z',
      'DTEND:20260915T120000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:multi-vevent-series',
      'RECURRENCE-ID:20260922T090000Z',
      'SUMMARY:Override Instance 2',
      'DTSTART:20260922T110000Z',
      'DTEND:20260922T120000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateWholeSeries(multiVeventIcs, {
      uid: 'multi-vevent-series',
      title: 'Updated Master Series Title',
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrence: 'FREQ=WEEKLY'
    });

    const veventMatches = updatedIcs.match(/BEGIN:VEVENT/g);
    assert.equal(veventMatches ? veventMatches.length : 0, 3, 'Must preserve all 3 VEVENT subcomponents (master + 2 detached overrides)');
    assert.ok(updatedIcs.includes('SUMMARY:Override Instance 1'), 'First detached override must be preserved');
    assert.ok(updatedIcs.includes('SUMMARY:Override Instance 2'), 'Second detached override must be preserved');
    assert.ok(updatedIcs.includes('EXDATE:20260908T090000Z'), 'EXDATE must be preserved');
  });


  await t.test('PUT /api/events/:uid preserves EXDATE and detached overrides when editing whole series via HTTP', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-241';
    await Db.upsertUser(testUserId, 'series241@example.com');

    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
    });
    assert.equal(authRes.status, 200);
    const cookie = authRes.headers.get('set-cookie').split(';')[0];
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'recurring-series-master-241';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;
    const initialIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'SUMMARY:Weekly Standup Original',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T093000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'EXDATE:20260908T090000Z',
      'DESCRIPTION:Sync meeting',
      'END:VEVENT',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'RECURRENCE-ID:20260915T090000Z',
      'SUMMARY:Single Instance Override',
      'DTSTART:20260915T100000Z',
      'DTEND:20260915T103000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    mockStore.set(eventUrl, { ics: initialIcs, etag: '"initial-etag-241"' });
    putCount = 0;

    // Perform whole-series PUT edit changing title to "Weekly Standup Updated"
    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-241',
        title: 'Weekly Standup Updated',
        start: '2026-09-01T09:00:00.000Z',
        end:   '2026-09-01T09:30:00.000Z',
        allDay: false,
        recurrence: 'FREQ=WEEKLY;BYDAY=TU',
        description: 'Sync meeting'
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    const resData = await putRes.json();
    assert.equal(resData.title, 'Weekly Standup Updated');
    assert.equal(putCount, 1, 'Edited save MUST issue PUT to CalDAV server');

    const storedRecord = mockStore.get(eventUrl);
    assert.ok(storedRecord.ics.includes('SUMMARY:Weekly Standup Updated'), 'Master event summary must be updated');
    assert.ok(storedRecord.ics.includes('EXDATE:20260908T090000Z'), 'EXDATE must be preserved in CalDAV store');
    assert.ok(storedRecord.ics.includes('SUMMARY:Single Instance Override'), 'Detached override VEVENT summary must be preserved in CalDAV store');
    assert.ok(storedRecord.ics.includes('RECURRENCE-ID:20260915T090000Z'), 'Detached RECURRENCE-ID must be preserved in CalDAV store');
  });
});
