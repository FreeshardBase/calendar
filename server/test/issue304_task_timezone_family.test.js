'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToTask,
  parseVTodoToTask,
  parseTaskList,
  taskToICS
} = require('../caldav/parser');
const ICAL = require('ical.js');

test.describe('Issue #304 — Task Timezone Family & Non-UTC Anchor Verification', () => {

  test('should parse VTODO with DUE anchored in TZID=Europe/Berlin', () => {
    const ics = [
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
      'END:VTIMEZONE',
      'BEGIN:VTODO',
      'UID:task-tzid-berlin-1',
      'SUMMARY:Berlin Team Sync',
      'STATUS:NEEDS-ACTION',
      'DUE;TZID=Europe/Berlin:20260815T140000',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics, { calendarId: 'cal-berlin' });
    assert.notEqual(task, null);
    assert.equal(task.uid, 'task-tzid-berlin-1');
    assert.equal(task.title, 'Berlin Team Sync');
    // 2026-08-15 14:00 CEST (UTC+2) -> 12:00 UTC
    assert.equal(task.due, '2026-08-15T12:00:00.000Z');
    assert.equal(task.dueIsDate, false);
  });

  test('should parse VTODO with DUE anchored in TZID=America/New_York', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'TZNAME:EDT',
      'DTSTART:19700308T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VTODO',
      'UID:task-tzid-ny-1',
      'SUMMARY:NYC Deadline',
      'DUE;TZID=America/New_York:20260815T100000',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    // 2026-08-15 10:00 EDT (UTC-4) -> 14:00 UTC
    assert.equal(task.due, '2026-08-15T14:00:00.000Z');
  });

  test('should parse VTODO with DATE-only DUE (VALUE=DATE)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-date-only-304',
      'SUMMARY:Jahresabschluss',
      'DUE;VALUE=DATE:20261231',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.equal(task.due, '2026-12-31T00:00:00.000Z');
    assert.equal(task.dueIsDate, true);
  });

  test('should parse VTODO with floating local time DUE (no Z, no TZID)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-floating-304',
      'SUMMARY:Mittagspause',
      'DUE:20260815T123000',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.ok(task.due.includes('2026-08-15'));
    assert.equal(task.dueIsDate, false);
  });

  test('should parse VTODO with DTSTART;TZID and DURATION calculating DUE in UTC', () => {
    const ics = [
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
      'END:VTIMEZONE',
      'BEGIN:VTODO',
      'UID:task-dtstart-duration-304',
      'SUMMARY:Server Maintenance',
      'DTSTART;TZID=Europe/Berlin:20260815T080000',
      'DURATION:PT4H',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    // DTSTART 08:00 CEST (06:00 UTC) + 4 hours = 12:00 CEST (10:00 UTC)
    assert.equal(task.due, '2026-08-15T10:00:00.000Z');
    assert.equal(task.duration, 'PT4H');
  });

  test('should parse CalDAV REPORT XML with VTIMEZONE and TZID-anchored VTODO tasks', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/task-tzid.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-tzid-1"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VTODO
UID:task-xml-tzid
SUMMARY:XML Task TZID
DUE;TZID=Europe/Berlin:20260815T160000
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const tasks = parseTaskList(xml, 'cal1', 'acc1', 'http://localhost/cal/');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].uid, 'task-xml-tzid');
    // 16:00 CEST -> 14:00 UTC
    assert.equal(tasks[0].due, '2026-08-15T14:00:00.000Z');
  });

  test('should round-trip serialize and re-parse timezone-anchored tasks without date shift', () => {
    const taskObj = {
      uid: 'task-roundtrip-304',
      title: 'Roundtrip TZ Test',
      status: 'NEEDS-ACTION',
      due: '2026-08-15T14:00:00.000Z',
      dueIsDate: false
    };

    const ics = taskToICS(taskObj);
    const parsed = parseICSToTask(ics);
    assert.notEqual(parsed, null);
    assert.equal(parsed.uid, 'task-roundtrip-304');
    assert.equal(parsed.due, '2026-08-15T14:00:00.000Z');
  });

});
