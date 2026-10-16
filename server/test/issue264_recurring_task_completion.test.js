'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '3264';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseICSToTask, parseTaskList, taskToICS, advanceRecurringTask } = require('../caldav/parser');

const SERIES_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Freeshard//WebCalendar 1.0//EN
BEGIN:VTODO
UID:task-rec-264
SUMMARY:Weekly Review
RRULE:FREQ=WEEKLY
DUE:20260824T150000Z
PRIORITY:2
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`;

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function multistatus(ics) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/testuser/tasks/task-rec-264.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-264"</d:getetag>
        <c:calendar-data>${escapeXml(ics)}</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

// What PUT /api/tasks/:uid stores for one press of the Kanban check button:
// the client sends STATUS:COMPLETED, the route advances the series server-side.
function completeOnce(ics, completed) {
  const current = parseICSToTask(ics);
  const advanced = advanceRecurringTask({ ...current, status: 'COMPLETED', percentComplete: 100, completed });
  assert.ok(advanced, 'an open weekly series must advance');
  return taskToICS(advanced, ics);
}

test.describe('Issue #264 — a completed occurrence of a recurring task reaches the task list as COMPLETED', () => {

  test('three completions store three COMPLETED occurrences while the master walks DUE forward', () => {
    let ics = SERIES_ICS;
    ics = completeOnce(ics, '2026-08-24T16:00:00.000Z');
    ics = completeOnce(ics, '2026-08-31T16:00:00.000Z');
    ics = completeOnce(ics, '2026-09-07T16:00:00.000Z');

    const vtodos = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vtodo');
    const master = vtodos.find(v => !v.getFirstProperty('recurrence-id'));
    assert.equal(master.getFirstPropertyValue('due').toString(), '2026-09-14T15:00:00Z');
    assert.equal(master.getFirstPropertyValue('status'), 'NEEDS-ACTION');
    const instances = vtodos.filter(v => v.getFirstProperty('recurrence-id'));
    assert.equal(instances.length, 3);
    for (const v of instances) {
      assert.equal(v.getFirstPropertyValue('status'), 'COMPLETED');
      assert.ok(v.getFirstProperty('completed'), 'each finished occurrence carries COMPLETED:');
      assert.equal(v.getFirstPropertyValue('percent-complete'), 100);
    }
  });

  test('parseTaskList lists every completed occurrence next to the open master, so the Erledigt column receives it', () => {
    let ics = SERIES_ICS;
    ics = completeOnce(ics, '2026-08-24T16:00:00.000Z');
    ics = completeOnce(ics, '2026-08-31T16:00:00.000Z');

    const tasks = parseTaskList(multistatus(ics), 'internal-caldav::/testuser/tasks/', 'internal-caldav', 'https://localhost:5232/testuser/tasks/');
    assert.equal(tasks.length, 3, 'master plus two completed occurrences');

    const master = tasks.find(t => !t.recurrenceId);
    assert.equal(master.status, 'NEEDS-ACTION');
    assert.equal(master.due, '2026-09-07T15:00:00.000Z');
    assert.equal(master.recurrence, 'FREQ=WEEKLY');

    const done = tasks.filter(t => t.recurrenceId).sort((a, b) => a.recurrenceId.localeCompare(b.recurrenceId));
    assert.deepEqual(done.map(t => t.recurrenceId), ['2026-08-24T15:00:00.000Z', '2026-08-31T15:00:00.000Z']);
    assert.deepEqual(done.map(t => t.due), ['2026-08-24T15:00:00.000Z', '2026-08-31T15:00:00.000Z']);
    assert.deepEqual(done.map(t => t.completed), ['2026-08-24T16:00:00.000Z', '2026-08-31T16:00:00.000Z']);
    for (const t of done) {
      assert.equal(t.status, 'COMPLETED');
      assert.equal(t.percentComplete, 100);
      assert.equal(t.uid, 'task-rec-264');
      assert.equal(t.title, 'Weekly Review');
      // An occurrence is not itself a series: it must not offer the series' rule.
      assert.equal(t.recurrence, null);
      // Same resource as the master: the board needs href/etag/calendarId to know where it lives.
      assert.equal(t.href, '/testuser/tasks/task-rec-264.ics');
      assert.equal(t.etag, '"etag-264"');
      assert.equal(t.calendarId, 'internal-caldav::/testuser/tasks/');
    }
  });

  test('an occurrence override that is still open is not listed as a separate task', () => {
    const ics = SERIES_ICS.replace('END:VCALENDAR', `BEGIN:VTODO
UID:task-rec-264
RECURRENCE-ID:20260831T150000Z
SUMMARY:Weekly Review (moved)
DUE:20260901T150000Z
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`);
    const tasks = parseTaskList(multistatus(ics), 'internal-caldav::/testuser/tasks/', 'internal-caldav', 'https://localhost:5232/testuser/tasks/');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].recurrenceId, undefined);
  });

  test('a foreign client\'s completed override without SUMMARY inherits the master\'s title', () => {
    const ics = SERIES_ICS.replace('END:VCALENDAR', `BEGIN:VTODO
UID:task-rec-264
RECURRENCE-ID:20260824T150000Z
STATUS:COMPLETED
COMPLETED:20260824T160000Z
END:VTODO
END:VCALENDAR`);
    const tasks = parseTaskList(multistatus(ics), 'internal-caldav::/testuser/tasks/', 'internal-caldav', 'https://localhost:5232/testuser/tasks/');
    const done = tasks.find(t => t.recurrenceId);
    assert.ok(done);
    assert.equal(done.title, 'Weekly Review');
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.due, null);
    assert.equal(done.recurrenceId, '2026-08-24T15:00:00.000Z');
  });
});
