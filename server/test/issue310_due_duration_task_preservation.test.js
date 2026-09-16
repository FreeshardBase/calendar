'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToTask,
  parseVTodoToTask,
  taskToICS,
  isNoOpTaskSave
} = require('../caldav/parser');

test.describe('Issue #310 — Task DUE and DURATION Mutual Exclusion & Preservation Suite', () => {

  test('taskToICS for task without DTSTART omits DURATION and writes DUE (RFC 5545 3.6.2 requirement)', () => {
    const task = {
      uid: 'task-no-dtstart-310',
      title: 'Task without DTSTART',
      due: '2026-06-05T12:00:00.000Z',
      duration: 'PT2H'
    };

    const generatedIcs = taskToICS(task);
    assert.ok(generatedIcs.includes('DUE:20260605T120000Z'), 'Generated ICS must contain DUE property');
    assert.ok(!generatedIcs.includes('DURATION:'), 'Generated ICS MUST NOT contain DURATION property when DTSTART is absent');
  });

  test('taskToICS for task with DTSTART enforces mutual exclusion between DUE and DURATION', () => {
    const task = {
      uid: 'task-both-310',
      title: 'Task with both fields',
      dtstart: '2026-06-01T10:00:00.000Z',
      due: '2026-06-01T12:00:00.000Z',
      duration: 'PT2H'
    };

    const generatedIcs = taskToICS(task);
    const hasDue = generatedIcs.includes('DUE:');
    const hasDuration = generatedIcs.includes('DURATION:');

    // RFC 5545 3.6.2: MUST NOT HAVE BOTH DUE AND DURATION
    assert.ok(!(hasDue && hasDuration), 'Output ICS MUST NOT contain BOTH DUE and DURATION properties');
  });

  test('Updating task with duration in existing ICS via taskToICS with new due removes DURATION and sets DUE', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-duration-orig',
      'SUMMARY:Original Duration Task',
      'DTSTART:20260601T100000Z',
      'DURATION:PT2H',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const updateTaskPayload = {
      uid: 'task-duration-orig',
      title: 'Original Duration Task',
      dtstart: '2026-06-01T10:00:00.000Z',
      due: '2026-06-05T12:00:00.000Z',
      duration: null // explicitly cleared or overridden by due
    };

    const updatedIcs = taskToICS(updateTaskPayload, existingIcs);
    assert.ok(updatedIcs.includes('DUE:20260605T120000Z'), 'Updated ICS must contain the new DUE date');
    assert.ok(!updatedIcs.includes('DURATION:'), 'Updated ICS must have DURATION removed when DUE is specified');
  });

  test('Updating task with DUE in existing ICS via taskToICS with new DURATION removes DUE and sets DURATION', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-due-orig',
      'SUMMARY:Original Due Task',
      'DTSTART:20260601T100000Z',
      'DUE:20260601T120000Z',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const updateTaskPayload = {
      uid: 'task-due-orig',
      title: 'Original Due Task',
      dtstart: '2026-06-01T10:00:00.000Z',
      due: null,
      duration: 'PT4H'
    };

    const updatedIcs = taskToICS(updateTaskPayload, existingIcs);
    assert.ok(updatedIcs.includes('DURATION:PT4H'), 'Updated ICS must contain the new DURATION');
    assert.ok(!updatedIcs.includes('DUE:'), 'Updated ICS must have DUE removed when DURATION is specified');
  });

  test('5 consecutive zero-edit save cycles on task with both DUE and DURATION preserve RFC 5545 compliance without throwing', () => {
    const rawIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-cycle-310',
      'SUMMARY:Cycle Task',
      'DTSTART:20260601T100000Z',
      'DUE:20260601T120000Z',
      'DURATION:PT2H',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    let currentIcs = rawIcs;
    for (let i = 0; i < 5; i++) {
      const parsed = parseICSToTask(currentIcs);
      assert.ok(parsed, `Cycle ${i+1}: parseICSToTask must succeed`);
      currentIcs = taskToICS(parsed, currentIcs);

      const hasDue = currentIcs.includes('DUE:');
      const hasDuration = currentIcs.includes('DURATION:');
      assert.ok(!(hasDue && hasDuration), `Cycle ${i+1}: output ICS MUST NOT contain both DUE and DURATION`);
    }
  });

});
