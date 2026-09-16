'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVTodoToTask,
  parseICSToTask,
  parseTaskList,
  taskToICS,
  advanceRecurringTask
} = require('../caldav/parser');

test.describe('VTODO / Tasks Parser & Serialization Suite', () => {

  test('should parse a basic VTODO object into a task JSON structure', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-12345',
      'SUMMARY:Einkaufen gehen',
      'DESCRIPTION:Milch\\, Brot und Eier kaufen',
      'STATUS:NEEDS-ACTION',
      'DUE:20260815T120000Z',
      'PRIORITY:1',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics, { calendarId: 'internal::cal1' });
    assert.notEqual(task, null);
    assert.equal(task.uid, 'task-12345');
    assert.equal(task.title, 'Einkaufen gehen');
    assert.equal(task.description, 'Milch, Brot und Eier kaufen');
    assert.equal(task.status, 'NEEDS-ACTION');
    assert.equal(task.priority, 1);
    assert.equal(task.calendarId, 'internal::cal1');
    assert.ok(task.due.includes('2026-08-15'));
  });

  test('should parse VTODO with RRULE recurrence rule', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-recurring-1',
      'SUMMARY:Wöchentlicher Bericht',
      'STATUS:IN-PROCESS',
      'DUE:20260810T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.equal(task.uid, 'task-recurring-1');
    assert.equal(task.status, 'IN-PROCESS');
    assert.equal(task.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
  });

  test('should serialize a task JSON object back to valid iCalendar VTODO format', () => {
    const taskObj = {
      uid: 'task-serialize-99',
      title: 'Projekt-Präsentation',
      description: 'Folien fertigstellen',
      status: 'COMPLETED',
      completed: '2026-08-10T10:00:00.000Z',
      due: '2026-08-10T09:00:00.000Z',
      priority: 2,
      recurrence: 'FREQ=MONTHLY'
    };

    const ics = taskToICS(taskObj);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('BEGIN:VTODO'));
    assert.ok(ics.includes('UID:task-serialize-99'));
    assert.ok(ics.includes('SUMMARY:Projekt-Präsentation'));
    assert.ok(ics.includes('STATUS:COMPLETED'));
    assert.ok(ics.includes('RRULE:FREQ=MONTHLY'));
    assert.ok(ics.includes('END:VTODO'));
    assert.ok(ics.includes('END:VCALENDAR'));
  });

  test('should parse multiple tasks from CalDAV REPORT XML response', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/task1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag123"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:t1
SUMMARY:Aufgabe 1
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/task2.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag456"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:t2
SUMMARY:Aufgabe 2
STATUS:COMPLETED
END:VTODO
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const tasks = parseTaskList(xml, 'cal1', 'acc1', 'http://localhost/cal/');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].uid, 't1');
    assert.equal(tasks[0].title, 'Aufgabe 1');
    assert.equal(tasks[0].status, 'NEEDS-ACTION');
    assert.equal(tasks[1].uid, 't2');
    assert.equal(tasks[1].title, 'Aufgabe 2');
    assert.equal(tasks[1].status, 'COMPLETED');
  });

  test('should advance recurring task due date upon completion (RRULE)', () => {
    const task = {
      uid: 'task-recur-adv',
      title: 'Tägliche Kontrolle',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=DAILY'
    };

    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.equal(advanced.completed, null);
    assert.ok(advanced.due.startsWith('2026-08-11'));

    const weeklyTask = {
      uid: 'task-weekly-adv',
      title: 'Wöchentliches Reporting',
      status: 'COMPLETED',
      due: '2026-08-10T10:00:00.000Z',
      recurrence: 'FREQ=WEEKLY'
    };
    const advancedWeekly = advanceRecurringTask(weeklyTask);
    assert.equal(advancedWeekly.status, 'NEEDS-ACTION');
    assert.ok(advancedWeekly.due.startsWith('2026-08-17'));
  });

  test('should parse VTODO anchored with TZID parameter (Issue #304 task timezone family)', () => {
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
      'UID:task-tzid-berlin',
      'SUMMARY:Meeting mit Berlin Team',
      'STATUS:NEEDS-ACTION',
      'DUE;TZID=Europe/Berlin:20260815T140000',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.equal(task.uid, 'task-tzid-berlin');
    assert.equal(task.due, '2026-08-15T12:00:00.000Z');
  });

  test('should parse VTODO with DATE-only DUE property (VALUE=DATE)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-date-only',
      'SUMMARY:Steuererklärung abgeben',
      'DUE;VALUE=DATE:20260815',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.equal(task.due, '2026-08-15T00:00:00.000Z');
    assert.equal(task.dueIsDate, true);
  });

  test('should parse VTODO with local floating time DUE property (no Z or TZID)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-floating-time',
      'SUMMARY:Medikamente einnehmen',
      'DUE:20260815T120000',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.ok(task.due.includes('2026-08-15'));
  });

  test('should parse VTODO anchored with DTSTART;TZID and DURATION', () => {
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
      'UID:task-dtstart-duration-tzid',
      'SUMMARY:Wartungsarbeiten Server',
      'DTSTART;TZID=Europe/Berlin:20260815T100000',
      'DURATION:PT2H',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.notEqual(task, null);
    assert.equal(task.due, '2026-08-15T10:00:00.000Z');
    assert.equal(task.duration, 'PT2H');
  });

});
