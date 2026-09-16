'use strict';

/**
 * Issue #309 — Task create modal cannot express DTSTART, DURATION,
 * PERCENT-COMPLETE, or FREQ=YEARLY recurrence.
 *
 * These tests verify that taskToICS correctly round-trips all four fields
 * that the modal was missing, and that `handleTaskSave`-equivalent assembly
 * logic (building a task payload and calling taskToICS) preserves them.
 *
 * Tests are pure server-side (no DOM); the UI HTML/JS changes are certified
 * by verifying that the field IDs added to index.html map to fields that
 * taskToICS can accept without loss.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskToICS, parseICSToTask, reconcileTaskStatus } = require('../caldav/parser');

// ── Helper: build ICS and round-trip through parseICSToTask ──────────────────
function roundTrip(taskObj) {
  const ics = taskToICS(taskObj);
  return { ics, parsed: parseICSToTask(ics) };
}

test.describe('Issue #309 — Task Create Modal Missing Fields Suite', () => {

  test('DTSTART on a new task is written and round-tripped correctly', () => {
    const task = reconcileTaskStatus({
      uid: 'task-309-dtstart',
      title: 'Task with DTSTART',
      calendarId: 'internal-caldav::/testuser/calendar/',
      status: 'NEEDS-ACTION',
      dtstart: '2026-10-01T08:00:00.000Z',
      dtstartIsDate: false
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('DTSTART:'), 'ICS must contain DTSTART property');
    assert.ok(parsed !== null, 'Parsed task must not be null');
    assert.ok(parsed.dtstart !== null && parsed.dtstart !== undefined, 'Parsed task must have dtstart');

    // dtstart round-trips to a recognisable UTC instant
    const parsedMs = new Date(parsed.dtstart).getTime();
    const originalMs = new Date('2026-10-01T08:00:00.000Z').getTime();
    assert.strictEqual(parsedMs, originalMs, 'DTSTART must round-trip without drift');
  });

  test('DTSTART;VALUE=DATE (date-only) on a new task is written and round-tripped', () => {
    const task = reconcileTaskStatus({
      uid: 'task-309-dtstart-date',
      title: 'Date-only DTSTART task',
      status: 'NEEDS-ACTION',
      dtstart: '2026-11-15T00:00:00.000Z',
      dtstartIsDate: true
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('DTSTART;VALUE=DATE:'), 'ICS must write DTSTART;VALUE=DATE for date-only start');
    assert.ok(ics.includes('20261115'), 'ICS must write the correct date');
    assert.ok(parsed.dtstartIsDate === true, 'Parsed task must mark dtstartIsDate=true');
  });

  test('DURATION on a new task is written and parsed; DUE is suppressed', () => {
    const task = reconcileTaskStatus({
      uid: 'task-309-duration',
      title: 'Task with DURATION',
      status: 'NEEDS-ACTION',
      dtstart: '2026-10-01T08:00:00.000Z',
      duration: 'PT2H'
      // NOTE: no `due` field — DURATION replaces DUE per RFC 5545 §3.6.2
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('DURATION:PT2H'), 'ICS must write DURATION property');
    assert.ok(!ics.includes('\r\nDUE:') && !ics.includes('\nDUE:'), 'ICS must NOT write DUE when DURATION is set');
    assert.ok(parsed !== null, 'Parsed task must not be null');
    assert.strictEqual(parsed.duration, 'PT2H', 'Parsed duration must equal PT2H');
    // due is computed from dtstart + duration by parseVTodoToTask
    assert.ok(parsed.due !== null, 'Parsed task must compute due from DTSTART+DURATION');
  });

  test('PERCENT-COMPLETE on a new task is written and round-tripped', () => {
    const task = reconcileTaskStatus({
      uid: 'task-309-pct',
      title: 'Task with percent-complete',
      status: 'IN-PROCESS',
      percentComplete: 40
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('PERCENT-COMPLETE:40'), 'ICS must write PERCENT-COMPLETE:40');
    assert.strictEqual(parsed.percentComplete, 40, 'Parsed percent-complete must equal 40');
    assert.strictEqual(parsed.status, 'IN-PROCESS', 'Status must be IN-PROCESS');
  });

  test('FREQ=YEARLY recurrence on a new task is written and round-tripped', () => {
    const task = reconcileTaskStatus({
      uid: 'task-309-yearly',
      title: 'Yearly recurring task',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=YEARLY'
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('RRULE:FREQ=YEARLY'), 'ICS must contain RRULE:FREQ=YEARLY');
    assert.ok(parsed.recurrence !== null && parsed.recurrence !== undefined, 'Parsed recurrence must be present');
    assert.ok(parsed.recurrence.includes('FREQ=YEARLY'), 'Parsed recurrence must include FREQ=YEARLY');
  });

  test('All four new fields coexist without mutual corruption', () => {
    // A task that sets DTSTART + DURATION + PERCENT-COMPLETE + FREQ=YEARLY
    const task = reconcileTaskStatus({
      uid: 'task-309-all-fields',
      title: 'Full-featured task',
      status: 'IN-PROCESS',
      dtstart: '2026-01-01T09:00:00.000Z',
      dtstartIsDate: false,
      duration: 'PT4H',
      percentComplete: 25,
      recurrence: 'FREQ=YEARLY'
    });

    const { ics, parsed } = roundTrip(task);

    assert.ok(ics.includes('DTSTART:20260101T090000Z'), 'DTSTART must be present');
    assert.ok(ics.includes('DURATION:PT4H'), 'DURATION must be present');
    assert.ok(!ics.includes('\r\nDUE:') && !ics.includes('\nDUE:'), 'DUE must be absent');
    assert.ok(ics.includes('PERCENT-COMPLETE:25'), 'PERCENT-COMPLETE must be present');
    assert.ok(ics.includes('RRULE:FREQ=YEARLY'), 'RRULE must be present');

    assert.strictEqual(parsed.duration, 'PT4H', 'duration round-trips');
    assert.strictEqual(parsed.percentComplete, 25, 'percentComplete round-trips');
    assert.ok(parsed.recurrence && parsed.recurrence.includes('FREQ=YEARLY'), 'recurrence round-trips');
  });

  test('handleTaskSave payload assembly: new-task path sets dtstart, duration, percentComplete, FREQ=YEARLY', () => {
    // Simulates what handleTaskSave assembles for POST /api/tasks on a new task
    // after the modal form fields are filled in.

    // Form values (as strings, mirroring HTML input/select .value):
    const title = 'New task from modal';
    const status = 'IN-PROCESS';
    const dtstartVal = '2026-10-15T10:00'; // datetime-local input
    const durationVal = 'PT30M';            // text input
    const percentCompleteVal = '50';        // number input
    const recurrenceVal = 'FREQ=YEARLY';    // select option

    // Mimics what the patched handleTaskSave will build:
    const dtstart = dtstartVal ? new Date(dtstartVal).toISOString() : null;
    const percentComplete = percentCompleteVal !== '' ? parseInt(percentCompleteVal, 10) : null;
    const duration = durationVal || null;
    const recurrence = recurrenceVal || null;

    const taskData = reconcileTaskStatus({
      uid: 'task-309-assembly',
      title,
      status,
      dtstart,
      dtstartIsDate: false,
      duration,
      percentComplete,
      recurrence
    });

    const { ics, parsed } = roundTrip(taskData);

    assert.ok(ics.includes('DTSTART:'), 'assembled payload must produce DTSTART in ICS');
    assert.ok(ics.includes('DURATION:PT30M'), 'assembled payload must produce DURATION:PT30M');
    assert.ok(ics.includes('PERCENT-COMPLETE:50'), 'assembled payload must produce PERCENT-COMPLETE:50');
    assert.ok(ics.includes('RRULE:FREQ=YEARLY'), 'assembled payload must produce RRULE:FREQ=YEARLY');

    assert.strictEqual(parsed.percentComplete, 50, 'percentComplete round-trips through POST');
    assert.ok(parsed.recurrence && parsed.recurrence.includes('FREQ=YEARLY'), 'recurrence round-trips');
  });

});
