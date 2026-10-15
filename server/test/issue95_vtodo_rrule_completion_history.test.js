'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3116';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = process.env.CALDAVURL || `http://localhost:${process.env.PORT}/mock-dav/`;
process.env.CALDAV_USERNAME = 'test';
process.env.CALDAV_PASSWORD = 'password';

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseICSToTask, parseVTodoToTask, taskToICS, advanceRecurringTask } = require('../caldav/parser');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;
const testUserId = 'test-issue95-user';

function splitVtodos(ics) {
  const vtodos = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vtodo');
  const masters = vtodos.filter(v => !v.getFirstProperty('recurrence-id'));
  assert.equal(masters.length, 1, 'exactly one master VTODO');
  return { master: masters[0], instances: vtodos.filter(v => v.getFirstProperty('recurrence-id')) };
}
// The session cookie is filled in by test.before() (#245: identity comes only from a session).
const authHeaders = {
  'Content-Type': 'application/json'
};

test.describe('Issue #95 — Recurring VTODO Completion History & Live Implementation', () => {

  test.before(async () => {
    if (server && !server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT || 3116, resolve));
    }
    authHeaders.cookie = await loginAs(testUserId);
  });

  test.after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      if (server.close) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (server.unref) {
        server.unref();
      }
    }
  });

  test('parseVTodoToTask parses X-COMPLETED-DATES into task.completedHistory', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:task-comp-hist-1
SUMMARY:Daily Workout
RRULE:FREQ=DAILY
DUE:20260831T100000Z
STATUS:NEEDS-ACTION
X-COMPLETED-DATES:2026-08-29T10:00:00.000Z,2026-08-30T10:00:00.000Z
END:VTODO
END:VCALENDAR`;

    const task = parseICSToTask(ics);
    assert.ok(task);
    assert.ok(Array.isArray(task.completedHistory));
    assert.equal(task.completedHistory.length, 2);
    assert.equal(task.completedHistory[0], '2026-08-29T10:00:00.000Z');
    assert.equal(task.completedHistory[1], '2026-08-30T10:00:00.000Z');
  });

  test('taskToICS serializes task.completedHistory into X-COMPLETED-DATES property', () => {
    const task = {
      uid: 'task-comp-hist-2',
      title: 'Daily Workout',
      recurrence: 'FREQ=DAILY',
      due: '2026-08-31T10:00:00.000Z',
      status: 'NEEDS-ACTION',
      completedHistory: ['2026-08-29T10:00:00.000Z', '2026-08-30T10:00:00.000Z']
    };

    const ics = taskToICS(task);
    assert.ok(ics.includes('X-COMPLETED-DATES'));
    assert.ok(ics.includes('2026-08-29T10:00:00.000Z'));
    assert.ok(ics.includes('2026-08-30T10:00:00.000Z'));

    const reParsed = parseICSToTask(ics);
    assert.deepEqual(reParsed.completedHistory, [
      '2026-08-29T10:00:00.000Z',
      '2026-08-30T10:00:00.000Z'
    ]);
  });

  test('advanceRecurringTask appends completion timestamp to completedHistory', () => {
    const task = {
      uid: 'task-comp-hist-3',
      title: 'Water Plants',
      recurrence: 'FREQ=DAILY',
      due: '2026-08-31T10:00:00.000Z',
      status: 'COMPLETED',
      completedHistory: ['2026-08-30T10:00:00.000Z']
    };

    const advanced = advanceRecurringTask(task);
    assert.ok(advanced);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.equal(advanced.due, '2026-09-01T10:00:00.000Z');
    assert.ok(Array.isArray(advanced.completedHistory));
    assert.equal(advanced.completedHistory.length, 2);
    assert.equal(advanced.completedHistory[0], '2026-08-30T10:00:00.000Z');
    assert.ok(advanced.completedHistory[1]); // New completion timestamp appended
  });

  test('ClaydeCode reproduction: DTSTART advances alongside DUE and COUNT decrements on each cycle', () => {
    // Initial task from Clayde's reproduction:
    // DTSTART=2026-08-07T09:00:00Z DUE=2026-08-10T09:00:00Z RRULE=FREQ=WEEKLY;BYDAY=MO;COUNT=4
    const task = {
      uid: 'task-clayde-repro',
      title: 'Weekly Standup Task',
      dtstart: '2026-08-07T09:00:00.000Z',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      status: 'NEEDS-ACTION'
    };

    // Cycle 1
    const cycle1 = advanceRecurringTask(task);
    assert.ok(cycle1, 'cycle 1 should produce advanced task');
    assert.equal(cycle1.due, '2026-08-17T09:00:00.000Z', 'cycle 1 due must advance to next Monday');
    assert.equal(cycle1.dtstart, '2026-08-14T09:00:00.000Z', 'cycle 1 dtstart must advance by occurrence delta (not sit at series origin)');
    assert.ok(cycle1.recurrence.includes('COUNT=3') && cycle1.recurrence.includes('FREQ=WEEKLY') && cycle1.recurrence.includes('BYDAY=MO'), 'cycle 1 recurrence must decrement COUNT to 3');
    assert.equal(cycle1.status, 'NEEDS-ACTION');

    // Cycle 2
    const cycle2 = advanceRecurringTask(cycle1);
    assert.ok(cycle2, 'cycle 2 should produce advanced task');
    assert.equal(cycle2.due, '2026-08-24T09:00:00.000Z');
    assert.equal(cycle2.dtstart, '2026-08-21T09:00:00.000Z');
    assert.ok(cycle2.recurrence.includes('COUNT=2') && cycle2.recurrence.includes('FREQ=WEEKLY') && cycle2.recurrence.includes('BYDAY=MO'), 'cycle 2 recurrence must decrement COUNT to 2');

    // Cycle 3
    const cycle3 = advanceRecurringTask(cycle2);
    assert.ok(cycle3, 'cycle 3 should produce advanced task');
    assert.equal(cycle3.due, '2026-08-31T09:00:00.000Z');
    assert.equal(cycle3.dtstart, '2026-08-28T09:00:00.000Z');
    assert.ok(cycle3.recurrence.includes('COUNT=1') && cycle3.recurrence.includes('FREQ=WEEKLY') && cycle3.recurrence.includes('BYDAY=MO'), 'cycle 3 recurrence must decrement COUNT to 1');

    // Cycle 4
    const cycle4 = advanceRecurringTask(cycle3);
    assert.equal(cycle4, null, 'cycle 4 must be null (series exhausted)');
  });

  test('taskToICS writes advanced DTSTART, DUE, decremented COUNT, and X-COMPLETED-DATES without stale COMPLETED timestamp', () => {
    const task = {
      uid: 'task-vtodo-rid-1',
      title: 'Weekly Status Report',
      dtstart: '2026-08-07T09:00:00.000Z',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      status: 'NEEDS-ACTION'
    };

    const advanced = advanceRecurringTask(task);
    assert.ok(advanced);

    const ics = taskToICS(advanced);
    assert.ok(ics.includes('STATUS:NEEDS-ACTION'), 'Master VTODO must have STATUS:NEEDS-ACTION');
    assert.equal(splitVtodos(ics).master.getFirstProperty('completed'), null, 'Active master task must not have COMPLETED: timestamp');
    assert.ok(ics.includes('X-COMPLETED-DATES:'), 'ICS must record completion in X-COMPLETED-DATES');
    assert.ok(ics.includes('DTSTART:20260814T090000Z'), 'ICS must serialize advanced DTSTART');
    assert.ok(ics.includes('DUE:20260817T090000Z'), 'ICS must serialize advanced DUE');
    assert.ok(ics.includes('COUNT=3'), 'ICS must serialize decremented COUNT');

    // Re-parsing the ICS must preserve the advanced task and extract completion history
    const reparsed = parseICSToTask(ics);
    assert.ok(reparsed);
    assert.equal(reparsed.due, '2026-08-17T09:00:00.000Z');
    assert.equal(reparsed.dtstart, '2026-08-14T09:00:00.000Z');
    assert.equal(reparsed.status, 'NEEDS-ACTION');
    assert.strictEqual(reparsed.completed, null);
    assert.ok(Array.isArray(reparsed.completedHistory) && reparsed.completedHistory.length === 1);
  });

  test('taskToICS writes a RECURRENCE-ID + STATUS:COMPLETED VTODO for the finished instance, kept in the master recurrence set', () => {
    const task = {
      uid: 'task-vtodo-rid-2',
      title: 'Weekly Status Report',
      dtstart: '2026-08-07T09:00:00.000Z',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      status: 'COMPLETED',
      completed: '2026-08-10T12:00:00.000Z'
    };

    const ics = taskToICS(advanceRecurringTask(task));
    const comp = new ICAL.Component(ICAL.parse(ics));
    const vtodos = comp.getAllSubcomponents('vtodo');
    assert.equal(vtodos.length, 2, 'master + one completed instance');

    const master = vtodos.find(v => !v.getFirstProperty('recurrence-id'));
    const instance = vtodos.find(v => v.getFirstProperty('recurrence-id'));
    assert.ok(master && instance);
    assert.equal(instance.getFirstPropertyValue('uid'), 'task-vtodo-rid-2');
    assert.equal(instance.getFirstPropertyValue('recurrence-id').toICALString(), '20260807T090000Z');
    assert.equal(instance.getFirstPropertyValue('status'), 'COMPLETED');
    assert.equal(instance.getFirstPropertyValue('completed').toICALString(), '20260810T120000Z');
    assert.equal(instance.getFirstPropertyValue('percent-complete'), 100);
    assert.equal(instance.getFirstPropertyValue('dtstart').toICALString(), '20260807T090000Z');
    assert.equal(instance.getFirstPropertyValue('due').toICALString(), '20260810T090000Z');
    assert.equal(instance.getFirstPropertyValue('summary'), 'Weekly Status Report');
    assert.ok(!instance.getFirstProperty('rrule'), 'an instance must not carry its own RRULE');

    assert.equal(master.getFirstPropertyValue('status'), 'NEEDS-ACTION');
    assert.equal(master.getFirstPropertyValue('dtstart').toICALString(), '20260814T090000Z');

    // A conformant client expands the master (DTSTART + RRULE + RDATE): the
    // completed instance must still be a member of the set, otherwise its
    // RECURRENCE-ID override is an orphan that clients drop.
    const expansion = new ICAL.RecurExpansion({ component: master, dtstart: master.getFirstPropertyValue('dtstart') });
    const occurrences = [];
    let next;
    while ((next = expansion.next()) && occurrences.length < 10) occurrences.push(next.toICALString());
    assert.ok(occurrences.includes('20260807T090000Z'), `completed instance must stay in the recurrence set, got ${occurrences}`);

    // The app keeps reading the master, never the instance.
    const reparsed = parseICSToTask(ics);
    assert.equal(reparsed.status, 'NEEDS-ACTION');
    assert.equal(reparsed.due, '2026-08-17T09:00:00.000Z');
  });

  test('all-day recurring VTODO without DTSTART: RECURRENCE-ID is the DATE-valued DUE of the finished instance', () => {
    const task = {
      uid: 'task-vtodo-rid-date',
      title: 'Daily Chore',
      due: '2026-08-10T00:00:00.000Z',
      dueIsDate: true,
      recurrence: 'FREQ=DAILY',
      status: 'COMPLETED',
      completed: '2026-08-10T12:00:00.000Z'
    };
    const ics = taskToICS(advanceRecurringTask(task));
    const vtodos = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vtodo');
    assert.equal(vtodos.length, 2);
    const instance = vtodos.find(v => v.getFirstProperty('recurrence-id'));
    const rid = instance.getFirstPropertyValue('recurrence-id');
    assert.equal(rid.isDate, true);
    assert.equal(rid.toICALString(), '20260810');
    const master = vtodos.find(v => !v.getFirstProperty('recurrence-id'));
    assert.equal(master.getFirstPropertyValue('due').toICALString(), '20260811');
  });

  test('completed instance inherits CLASS and the stored master value types, and is not duplicated per occurrence', () => {
    const stored = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
      'BEGIN:VTODO',
      'UID:task-vtodo-rid-class',
      'DTSTAMP:20260801T000000Z',
      'SUMMARY:Private chore',
      'CLASS:PRIVATE',
      'DUE;VALUE=DATE:20260810',
      'RRULE:FREQ=DAILY',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'BEGIN:VTODO',
      'UID:task-vtodo-rid-class',
      'DTSTAMP:20260801T000000Z',
      'RECURRENCE-ID;VALUE=DATE:20260810',
      'SUMMARY:Private chore',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');
    const current = parseICSToTask(stored);
    // API payload that names DUE without saying it is all-day.
    const { dueIsDate, ...payload } = current;
    const advanced = advanceRecurringTask({ ...payload, status: 'COMPLETED', completed: '2026-08-10T12:00:00.000Z' });
    const ics = taskToICS(advanced, stored);
    const vtodos = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vtodo');
    const instances = vtodos.filter(v => v.getFirstProperty('recurrence-id'));
    assert.equal(instances.length, 1, 'the existing override for the same occurrence is replaced, not duplicated');
    const instance = instances[0];
    assert.equal(instance.getFirstPropertyValue('class'), 'PRIVATE');
    assert.equal(instance.getFirstPropertyValue('status'), 'COMPLETED');
    const rid = instance.getFirstPropertyValue('recurrence-id');
    assert.equal(rid.isDate, true, 'RECURRENCE-ID must match the stored DATE type');
    assert.equal(rid.toICALString(), '20260810');
    assert.equal(instance.getFirstPropertyValue('due').isDate, true);
  });

  test('live PUT /api/tasks/:uid advances recurring task, writes X-COMPLETED-DATES to CalDAV, and terminates upon series exhaustion', async () => {
    // 1. Initialize user session accounts via /api/accounts
    const accRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: authHeaders.cookie }
    });
    assert.equal(accRes.status, 200);

    const targetCalendarId = 'env-default::/mock-dav/calendars/test/personal/';

    // 2. Create recurring task via POST /api/tasks with Clayde reproduction parameters
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        title: 'Live Weekly Standup Task',
        dtstart: '2026-08-07T09:00:00.000Z',
        due: '2026-08-10T09:00:00.000Z',
        recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
        status: 'NEEDS-ACTION'
      })
    });
    assert.equal(createRes.status, 201);
    const createdTask = await createRes.json();
    assert.ok(createdTask.uid);
    assert.ok(createdTask.href);
    assert.equal(createdTask.status, 'NEEDS-ACTION');

    // 3. Cycle 1: Mark completed via PUT /api/tasks/:uid
    const putRes1 = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: createdTask.href,
        etag: createdTask.etag,
        status: 'COMPLETED'
      })
    });
    assert.equal(putRes1.status, 200);
    const updated1 = await putRes1.json();
    assert.equal(updated1.status, 'NEEDS-ACTION');
    assert.equal(updated1.due, '2026-08-17T09:00:00.000Z');
    assert.equal(updated1.dtstart, '2026-08-14T09:00:00.000Z');
    assert.ok(updated1.recurrence.includes('COUNT=3') && updated1.recurrence.includes('FREQ=WEEKLY') && updated1.recurrence.includes('BYDAY=MO'), 'recurrence must decrement COUNT to 3');
    assert.ok(Array.isArray(updated1.completedHistory) && updated1.completedHistory.length === 1);

    // Verify raw CalDAV ICS written to mock-dav
    const rawIcsRes1 = await fetch(updated1.href);
    assert.equal(rawIcsRes1.status, 200);
    const rawIcs1 = await rawIcsRes1.text();
    assert.ok(rawIcs1.includes('X-COMPLETED-DATES:'), 'CalDAV ICS must contain X-COMPLETED-DATES');
    const stored1 = splitVtodos(rawIcs1);
    assert.equal(stored1.instances.length, 1, 'one completed instance VTODO stored');
    assert.equal(stored1.master.getFirstPropertyValue('status'), 'NEEDS-ACTION');
    assert.equal(stored1.master.getFirstProperty('completed'), null, 'Active master task must not have COMPLETED: timestamp');
    assert.equal(stored1.master.getFirstPropertyValue('dtstart').toICALString(), '20260814T090000Z');
    assert.equal(stored1.master.getFirstPropertyValue('due').toICALString(), '20260817T090000Z');
    assert.equal(stored1.instances[0].getFirstPropertyValue('status'), 'COMPLETED');
    assert.equal(stored1.instances[0].getFirstPropertyValue('uid'), createdTask.uid);

    assert.equal(updated1.completedInstance, undefined, 'internal instance data must not leak into the API');

    // A client cannot forge a completion instance through the request body.
    const forgeRes = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: updated1.href,
        etag: updated1.etag,
        description: 'forged',
        completedInstance: { recurrenceId: '2030-01-01T00:00:00.000Z', title: 'forged', completed: '2030-01-01T00:00:00.000Z' }
      })
    });
    assert.equal(forgeRes.status, 200);
    const forged = await forgeRes.json();
    const storedForge = splitVtodos(await (await fetch(updated1.href)).text());
    assert.equal(storedForge.instances.length, 1, 'a body-supplied completedInstance must be ignored');
    assert.equal(storedForge.master.getFirstPropertyValue('description'), 'forged');

    // An ordinary edit that echoes the whole task back must not add another instance.
    const editRes = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ ...forged, calendarId: targetCalendarId, title: 'Live Weekly Standup Task (renamed)' })
    });
    assert.equal(editRes.status, 200);
    const edited = await editRes.json();
    assert.equal(edited.completedInstance, undefined, 'internal instance data must not leak into the API');
    const storedEdit = splitVtodos(await (await fetch(updated1.href)).text());
    assert.equal(storedEdit.instances.length, 1, 'a plain edit must not write a completion instance');
    assert.equal(storedEdit.master.getFirstPropertyValue('summary'), 'Live Weekly Standup Task (renamed)');

    // 4. Cycle 2: Complete next occurrence
    const putRes2 = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: edited.href,
        etag: edited.etag,
        status: 'COMPLETED'
      })
    });
    assert.equal(putRes2.status, 200);
    const updated2 = await putRes2.json();
    assert.equal(updated2.status, 'NEEDS-ACTION');
    assert.equal(updated2.due, '2026-08-24T09:00:00.000Z');
    assert.equal(updated2.dtstart, '2026-08-21T09:00:00.000Z');
    assert.ok(updated2.recurrence.includes('COUNT=2') && updated2.recurrence.includes('FREQ=WEEKLY') && updated2.recurrence.includes('BYDAY=MO'), 'recurrence must decrement COUNT to 2');
    assert.equal(updated2.completedHistory.length, 2);

    // 5. Cycle 3: Complete next occurrence
    const putRes3 = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: updated2.href,
        etag: updated2.etag,
        status: 'COMPLETED'
      })
    });
    assert.equal(putRes3.status, 200);
    const updated3 = await putRes3.json();
    assert.equal(updated3.status, 'NEEDS-ACTION');
    assert.equal(updated3.due, '2026-08-31T09:00:00.000Z');
    assert.equal(updated3.dtstart, '2026-08-28T09:00:00.000Z');
    assert.ok(updated3.recurrence.includes('COUNT=1') && updated3.recurrence.includes('FREQ=WEEKLY') && updated3.recurrence.includes('BYDAY=MO'), 'recurrence must decrement COUNT to 1');
    assert.equal(updated3.completedHistory.length, 3);

    const stored3 = splitVtodos(await (await fetch(updated3.href)).text());
    assert.deepEqual(
      stored3.instances.map(v => v.getFirstPropertyValue('recurrence-id').toICALString()).sort(),
      ['20260807T090000Z', '20260814T090000Z', '20260821T090000Z'],
      'each finished occurrence gets its own RECURRENCE-ID VTODO'
    );
    assert.ok(stored3.instances.every(v => v.getFirstPropertyValue('status') === 'COMPLETED'));

    // 6. Cycle 4: Complete final occurrence -> series exhausted
    const putRes4 = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: updated3.href,
        etag: updated3.etag,
        status: 'COMPLETED'
      })
    });
    assert.equal(putRes4.status, 200);
    const updated4 = await putRes4.json();
    assert.equal(updated4.status, 'COMPLETED', 'Exhausted series must remain COMPLETED');
    assert.equal(updated4.percentComplete, 100);
    const stored4 = splitVtodos(await (await fetch(updated4.href)).text());
    assert.equal(stored4.master.getFirstPropertyValue('status'), 'COMPLETED');
    assert.equal(stored4.instances.length, 3, 'earlier instances survive the final completion');
  });

});
