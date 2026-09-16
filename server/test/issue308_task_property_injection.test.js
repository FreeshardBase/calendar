'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  taskToICS,
  reconcileTaskStatus,
  parseICSToTask
} = require('../caldav/parser');

test.describe('Issue #308 — Task Property Injection & Parameter Validation Suite', () => {

  test('taskToICS (fallback mode) sanitizes STATUS and rejects property injection', () => {
    const taskObj = {
      uid: 'task-inj-status',
      title: 'Status Test Task',
      status: 'NEEDS-ACTION\r\nX-INJECTED-STATUS:HACK\r\nSUMMARY:HACKED'
    };

    const ics = taskToICS(taskObj);
    assert.ok(!ics.includes('X-INJECTED-STATUS'), 'ICS must not contain injected property');
    assert.ok(!ics.includes('SUMMARY:HACKED'), 'ICS must not contain injected SUMMARY');
    assert.ok(ics.includes('STATUS:NEEDS-ACTION'), 'ICS must set valid clean STATUS');
  });

  test('taskToICS (fallback mode) validates PRIORITY and rejects string/CRLF injection', () => {
    const maliciousTask = {
      uid: 'task-inj-priority-1',
      title: 'Priority Test Task',
      priority: '1\r\nX-INJECTED-PRIORITY:HACK'
    };

    const ics = taskToICS(maliciousTask);
    assert.ok(!ics.includes('X-INJECTED-PRIORITY'), 'ICS must not contain injected property');
    assert.ok(ics.includes('PRIORITY:1'), 'ICS must parse valid integer priority');

    const invalidTask = {
      uid: 'task-inj-priority-2',
      title: 'Priority Test Task 2',
      priority: 'HIGH'
    };

    const icsInvalid = taskToICS(invalidTask);
    assert.ok(!icsInvalid.includes('PRIORITY:HIGH'), 'ICS must not output raw string PRIORITY');
    assert.ok(!icsInvalid.includes('PRIORITY:NaN'), 'ICS must not output PRIORITY:NaN');

    const outOfBoundsTask = {
      uid: 'task-inj-priority-3',
      title: 'Priority Test Task 3',
      priority: 15
    };

    const icsOutOfBounds = taskToICS(outOfBoundsTask);
    assert.ok(!icsOutOfBounds.includes('PRIORITY:15'), 'ICS must reject PRIORITY out of bounds (>9)');
  });

  test('taskToICS (fallback mode) validates PERCENT-COMPLETE and rejects CRLF/NaN injection', () => {
    const maliciousTask = {
      uid: 'task-inj-pct-1',
      title: 'Percent Complete Test',
      percentComplete: '50\r\nX-INJECTED-PCT:HACK'
    };

    const ics = taskToICS(maliciousTask);
    assert.ok(!ics.includes('X-INJECTED-PCT'), 'ICS must not contain injected property');
    assert.ok(ics.includes('PERCENT-COMPLETE:50'), 'ICS must parse valid integer percentComplete');

    const invalidTask = {
      uid: 'task-inj-pct-2',
      title: 'Percent Complete Test 2',
      percentComplete: 'HALF'
    };

    const icsInvalid = taskToICS(invalidTask);
    assert.ok(!icsInvalid.includes('PERCENT-COMPLETE:HALF'), 'ICS must not output raw string percentComplete');
    assert.ok(!icsInvalid.includes('PERCENT-COMPLETE:NaN'), 'ICS must not output PERCENT-COMPLETE:NaN');

    const outOfBoundsTask = {
      uid: 'task-inj-pct-3',
      title: 'Percent Complete Test 3',
      percentComplete: 200
    };

    const icsOutOfBounds = taskToICS(outOfBoundsTask);
    assert.ok(!icsOutOfBounds.includes('PERCENT-COMPLETE:200'), 'ICS must reject PERCENT-COMPLETE > 100');
  });

  test('taskToICS (fallback mode) validates RRULE and rejects CRLF/invalid syntax injection', () => {
    const maliciousTask = {
      uid: 'task-inj-rrule-1',
      title: 'RRULE Test Task',
      recurrence: 'FREQ=DAILY\r\nX-INJECTED-RRULE:HACK\r\nSUMMARY:PWNED'
    };

    const ics = taskToICS(maliciousTask);
    assert.ok(!ics.includes('X-INJECTED-RRULE'), 'ICS must not contain injected property');
    assert.ok(!ics.includes('SUMMARY:PWNED'), 'ICS must not contain injected summary');
    assert.ok(ics.includes('RRULE:FREQ=DAILY'), 'ICS must keep sanitized valid RRULE portion');

    const invalidTask = {
      uid: 'task-inj-rrule-2',
      title: 'RRULE Test Task 2',
      recurrence: 'NOT_A_VALID_RRULE'
    };

    const icsInvalid = taskToICS(invalidTask);
    assert.ok(!icsInvalid.includes('RRULE:NOT_A_VALID_RRULE'), 'ICS must omit invalid RRULE string');
  });

  test('taskToICS (jcal baseIcs mode) sanitizes STATUS, PRIORITY, PERCENT-COMPLETE, and RRULE', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-jcal-inj',
      'SUMMARY:Existing Task',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const updateData = {
      uid: 'task-jcal-inj',
      title: 'Existing Task Updated',
      status: 'IN-PROCESS\r\nX-INJECTED:STATUS_HACK',
      priority: '2\r\nX-INJECTED:PRIO_HACK',
      percentComplete: '75\r\nX-INJECTED:PCT_HACK',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO\r\nX-INJECTED:RRULE_HACK'
    };

    const updatedIcs = taskToICS(updateData, existingIcs);
    assert.ok(!updatedIcs.includes('X-INJECTED'), 'Updated jcal ICS must not contain injected properties');
    assert.ok(updatedIcs.includes('STATUS:IN-PROCESS'), 'Updated jcal ICS must contain sanitized STATUS');
    assert.ok(updatedIcs.includes('PRIORITY:2'), 'Updated jcal ICS must contain sanitized PRIORITY');
    assert.ok(updatedIcs.includes('PERCENT-COMPLETE:75'), 'Updated jcal ICS must contain sanitized PERCENT-COMPLETE');
    assert.ok(updatedIcs.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'Updated jcal ICS must contain sanitized RRULE');

    const parsedTask = parseICSToTask(updatedIcs);
    assert.equal(parsedTask.title, 'Existing Task Updated');
    assert.equal(parsedTask.status, 'IN-PROCESS');
    assert.equal(parsedTask.priority, 2);
    assert.equal(parsedTask.percentComplete, 75);
    assert.equal(parsedTask.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
  });

  test('reconcileTaskStatus sanitizes status field containing control characters or newlines', () => {
    const reconciled = reconcileTaskStatus({
      status: 'NEEDS-ACTION\r\nX-INJECTED:EVIL'
    });

    assert.equal(reconciled.status, 'NEEDS-ACTION');
    assert.ok(!JSON.stringify(reconciled).includes('X-INJECTED'));
  });

});
