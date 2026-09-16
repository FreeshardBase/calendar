'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskToICS, parseICSToTask } = require('../caldav/parser');
const { validateTaskInput } = require('../routes/tasks');

test.describe('Issue #311 — Task POST / PUT Input Validation & Opaque 500 Prevention Suite', () => {

  test('validateTaskInput rejects invalid dtstart date', () => {
    const res = validateTaskInput({ dtstart: 'invalid-date' });
    assert.ok(res, 'Validation error object must be returned');
    assert.match(res.error, /dtstart/i);
  });

  test('validateTaskInput rejects invalid due date', () => {
    const res = validateTaskInput({ due: 'not-a-valid-date' });
    assert.ok(res, 'Validation error object must be returned');
    assert.match(res.error, /due/i);
  });

  test('validateTaskInput rejects invalid completed date', () => {
    const res = validateTaskInput({ completed: '2026-99-99T99:99:99Z' });
    assert.ok(res, 'Validation error object must be returned');
    assert.match(res.error, /completed/i);
  });

  test('validateTaskInput rejects invalid duration string', () => {
    const res1 = validateTaskInput({ duration: 'invalid-duration' });
    assert.ok(res1, 'Validation error object must be returned for non-ISO duration');
    assert.match(res1.error, /duration/i);

    const res2 = validateTaskInput({ duration: '123' });
    assert.ok(res2, 'Validation error object must be returned for numeric duration');
    assert.match(res2.error, /duration/i);
  });

  test('validateTaskInput rejects invalid recurrence rule', () => {
    const res = validateTaskInput({ recurrence: 'NOT_A_VALID_RRULE' });
    assert.ok(res, 'Validation error object must be returned for invalid RRULE');
    assert.match(res.error, /recurrence|rrule/i);
  });

  test('validateTaskInput accepts valid task input payload', () => {
    const validPayload = {
      title: 'Valid Task',
      dtstart: '2026-10-01T09:00:00Z',
      due: '2026-10-01T17:00:00Z',
      duration: 'PT2H',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      priority: 3,
      percentComplete: 50
    };
    const res = validateTaskInput(validPayload);
    assert.equal(res, null, 'validateTaskInput must return null for valid payload');
  });

  test('taskToICS suppresses invalid date and duration strings in fallback ICS mode', () => {
    const corruptedTask = {
      uid: 'task-corrupted-dates',
      title: 'Corrupted Dates Task',
      dtstart: 'invalid-date',
      due: 'not-a-date',
      completed: 'bad-completed',
      duration: 'invalid-duration'
    };

    const ics = taskToICS(corruptedTask);
    assert.ok(!ics.includes('DTSTART:invalid-date'), 'ICS must not contain invalid DTSTART');
    assert.ok(!ics.includes('DUE:not-a-date'), 'ICS must not contain invalid DUE');
    assert.ok(!ics.includes('DUE;VALUE=DATE:NaNNaNNaN'), 'ICS must not contain NaN DUE date');
    assert.ok(!ics.includes('COMPLETED:bad-completed'), 'ICS must not contain invalid COMPLETED');
    assert.ok(!ics.includes('DURATION:invalid-duration'), 'ICS must not contain invalid DURATION');
  });

  test('taskToICS suppresses invalid date and duration strings in jcal mode', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-jcal-corrupted',
      'SUMMARY:Jcal Corrupted Task',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatePayload = {
      uid: 'task-jcal-corrupted',
      title: 'Jcal Corrupted Task Updated',
      dtstart: 'invalid-dtstart',
      due: 'invalid-due',
      duration: 'invalid-duration'
    };

    const updatedIcs = taskToICS(updatePayload, existingIcs);
    assert.ok(!updatedIcs.includes('invalid-dtstart'), 'jcal ICS must omit invalid dtstart');
    assert.ok(!updatedIcs.includes('invalid-due'), 'jcal ICS must omit invalid due');
    assert.ok(!updatedIcs.includes('invalid-duration'), 'jcal ICS must omit invalid duration');
  });

});
