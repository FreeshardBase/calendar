'use strict';
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
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const ICAL = require('ical.js');
const { parseICSToTask, parseVTodoToTask, taskToICS, advanceRecurringTask } = require('../caldav/parser');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;
const testUserId = 'test-issue95-user';
const authHeaders = {
  'Content-Type': 'application/json',
  'x-test-user-id': testUserId
};

test.describe('Issue #95 — Recurring VTODO Completion History & Live Implementation', () => {

  test.before(async () => {
    if (server && !server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT || 3116, resolve));
    }
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
    assert.ok(!ics.includes('COMPLETED:'), 'Active master task must not have COMPLETED: timestamp');
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

  test('advanceRecurringTaskJS in public/js/tasks.js advances DTSTART alongside DUE and decrements COUNT', () => {
    const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
    const rawTasksJs = fs.readFileSync(tasksJsPath, 'utf8');
    const cjsTasksJs = rawTasksJs
      .replace(/^import\s+.*?;/gm, '')
      .replace(/^export\s+/gm, '');

    const context = {
      console,
      window: { ICAL },
      ICAL,
      require,
      Date,
      String,
      parseInt,
      isNaN,
      Array,
      Set,
      escapeHtml: (s) => s,
      TasksAPI: {},
      notifyToast: () => {},
      closeTaskModal: () => {},
      openTaskModal: () => {},
      confirmDialog: () => true,
      taskCallbacks: {},
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsTasksJs, context);

    assert.equal(typeof context.advanceRecurringTaskJS, 'function');

    const task = {
      uid: 'task-js-advance-test',
      title: 'Weekly Standup JS',
      dtstart: '2026-08-07T09:00:00.000Z',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      status: 'NEEDS-ACTION'
    };

    const cycle1 = context.advanceRecurringTaskJS(task);
    assert.ok(cycle1);
    assert.equal(cycle1.due, '2026-08-17T09:00:00.000Z');
    assert.equal(cycle1.dtstart, '2026-08-14T09:00:00.000Z');
    assert.ok(cycle1.recurrence.includes('COUNT=3') && cycle1.recurrence.includes('FREQ=WEEKLY') && cycle1.recurrence.includes('BYDAY=MO'));
    assert.equal(cycle1.status, 'NEEDS-ACTION');
    assert.ok(Array.isArray(cycle1.completedHistory) && cycle1.completedHistory.length === 1);

    const cycle2 = context.advanceRecurringTaskJS(cycle1);
    assert.equal(cycle2.due, '2026-08-24T09:00:00.000Z');
    assert.equal(cycle2.dtstart, '2026-08-21T09:00:00.000Z');
    assert.ok(cycle2.recurrence.includes('COUNT=2') && cycle2.recurrence.includes('FREQ=WEEKLY') && cycle2.recurrence.includes('BYDAY=MO'));
    assert.equal(cycle2.completedHistory.length, 2);

    const cycle3 = context.advanceRecurringTaskJS(cycle2);
    assert.equal(cycle3.due, '2026-08-31T09:00:00.000Z');
    assert.equal(cycle3.dtstart, '2026-08-28T09:00:00.000Z');
    assert.ok(cycle3.recurrence.includes('COUNT=1') && cycle3.recurrence.includes('FREQ=WEEKLY') && cycle3.recurrence.includes('BYDAY=MO'));
    assert.equal(cycle3.completedHistory.length, 3);

    const cycle4 = context.advanceRecurringTaskJS(cycle3);
    assert.equal(cycle4.status, 'COMPLETED');
    assert.equal(cycle4.percentComplete, 100);
  });

  test('live PUT /api/tasks/:uid advances recurring task, writes X-COMPLETED-DATES to CalDAV, and terminates upon series exhaustion', async () => {
    // 1. Initialize user session accounts via /api/accounts
    const accRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': testUserId }
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
    assert.ok(!rawIcs1.includes('COMPLETED:'), 'Active master task must not have COMPLETED: timestamp');
    assert.ok(rawIcs1.includes('STATUS:NEEDS-ACTION'), 'CalDAV ICS must have active master VTODO');
    assert.ok(rawIcs1.includes('DTSTART:20260814T090000Z'), 'CalDAV ICS must store advanced DTSTART');
    assert.ok(rawIcs1.includes('DUE:20260817T090000Z'), 'CalDAV ICS must store advanced DUE');

    // 4. Cycle 2: Complete next occurrence
    const putRes2 = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: updated1.href,
        etag: updated1.etag,
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
  });

});
