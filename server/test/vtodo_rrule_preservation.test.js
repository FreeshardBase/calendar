'use strict';

/**
 * Issue #261 — VTODO Zero-Edit RRULE Preservation
 *
 * Guards against two related failure modes:
 *   A) taskToICS drops the RRULE when the incoming task object omits `recurrence`
 *      (frontend only sends changed fields, does not echo back recurrence).
 *   B) isNoOpTaskSave detects zero-edit saves so PUT /api/tasks/:uid can skip
 *      redundant CalDAV PUTs that would destroy RRULE via the scratch ICS builder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToTask, taskToICS, isNoOpTaskSave } = require('../caldav/parser');

const RECURRING_TASK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Freeshard//WebCalendar 1.0//EN',
  'BEGIN:VTODO',
  'UID:task-rrule-261',
  'SUMMARY:Weekly Report',
  'DESCRIPTION:Submit weekly status report',
  'STATUS:NEEDS-ACTION',
  'DUE:20260901T090000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'CATEGORIES:WORK',
  'X-FREESHARD-TAG:issue-261',
  'END:VTODO',
  'END:VCALENDAR'
].join('\r\n');

test.describe('Issue #261 — VTODO Zero-Edit RRULE Preservation', () => {

  // ── A: taskToICS — RRULE preserved when recurrence key absent ────────────

  test('taskToICS preserves RRULE from existingIcs when task omits recurrence key', () => {
    const updatePayload = {
      uid: 'task-rrule-261',
      title: 'Weekly Report (Revised)',
      status: 'NEEDS-ACTION'
      // NOTE: no recurrence key at all
    };
    const result = taskToICS(updatePayload, RECURRING_TASK_ICS);
    assert.ok(result.includes('SUMMARY:Weekly Report (Revised)'), 'Summary must be updated');
    assert.ok(result.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'), 'RRULE must be preserved from existing ICS');
    assert.ok(result.includes('CATEGORIES:WORK'), 'CATEGORIES must be preserved');
    assert.ok(result.includes('X-FREESHARD-TAG:issue-261'), 'X-* property must be preserved');
  });

  test('taskToICS preserves RRULE when task.recurrence is explicitly undefined', () => {
    const updatePayload = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'IN-PROCESS',
      recurrence: undefined
    };
    const result = taskToICS(updatePayload, RECURRING_TASK_ICS);
    assert.ok(result.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'),
      'RRULE must be preserved when recurrence is undefined');
  });

  test('taskToICS removes RRULE when recurrence is explicitly null', () => {
    const updatePayload = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'NEEDS-ACTION',
      recurrence: null
    };
    const result = taskToICS(updatePayload, RECURRING_TASK_ICS);
    assert.ok(!result.includes('RRULE:'), 'RRULE must be removed when recurrence is null');
  });

  test('taskToICS updates RRULE when recurrence is a new rule string', () => {
    const updatePayload = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=1'
    };
    const result = taskToICS(updatePayload, RECURRING_TASK_ICS);
    assert.ok(result.includes('FREQ=MONTHLY'), 'RRULE must be updated to new rule');
    assert.ok(!result.includes('FREQ=WEEKLY'), 'Old RRULE must not remain');
  });

  test('taskToICS preserves RRULE via task.rawIcs when existingIcs arg is omitted', () => {
    const task = parseICSToTask(RECURRING_TASK_ICS);
    task.status = 'IN-PROCESS';
    delete task.recurrence; // key absent
    const result = taskToICS(task); // no explicit existingIcs
    assert.ok(result.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'),
      'RRULE must be preserved via task.rawIcs when recurrence key is absent');
    assert.ok(result.includes('STATUS:IN-PROCESS'), 'Status must be updated');
  });

  // ── B: isNoOpTaskSave ────────────────────────────────────────────────────

  test('isNoOpTaskSave is exported from parser', () => {
    assert.equal(typeof isNoOpTaskSave, 'function', 'isNoOpTaskSave must be exported');
  });

  test('isNoOpTaskSave returns true for zero-edit (identical fields)', () => {
    const task = parseICSToTask(RECURRING_TASK_ICS);
    const incoming = {
      uid: task.uid,
      title: task.title,
      status: task.status,
      description: task.description,
      due: task.due,
      recurrence: task.recurrence
    };
    assert.equal(isNoOpTaskSave(RECURRING_TASK_ICS, incoming), true,
      'Identical data must be detected as no-op');
  });

  test('isNoOpTaskSave returns false when title changes', () => {
    const incoming = {
      uid: 'task-rrule-261',
      title: 'DIFFERENT TITLE',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO'
    };
    assert.equal(isNoOpTaskSave(RECURRING_TASK_ICS, incoming), false,
      'Changed title must not be no-op');
  });

  test('isNoOpTaskSave returns false when status changes', () => {
    const incoming = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'COMPLETED'
    };
    assert.equal(isNoOpTaskSave(RECURRING_TASK_ICS, incoming), false);
  });

  test('isNoOpTaskSave returns false when recurrence changes', () => {
    const incoming = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=DAILY'
    };
    assert.equal(isNoOpTaskSave(RECURRING_TASK_ICS, incoming), false);
  });

  test('isNoOpTaskSave returns false when recurrence is removed (null)', () => {
    const incoming = {
      uid: 'task-rrule-261',
      title: 'Weekly Report',
      status: 'NEEDS-ACTION',
      recurrence: null
    };
    assert.equal(isNoOpTaskSave(RECURRING_TASK_ICS, incoming), false,
      'Removing recurrence must not be no-op');
  });

  test('isNoOpTaskSave returns false (safe default) when existingIcs is null', () => {
    assert.equal(isNoOpTaskSave(null, { title: 'Any Task' }), false);
  });

  test('isNoOpTaskSave returns false (safe default) when existingIcs is unparseable', () => {
    assert.equal(isNoOpTaskSave('NOT VALID ICS', { title: 'Any Task' }), false);
  });

});
