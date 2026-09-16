'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToTask,
  parseVTodoToTask,
  taskToICS,
  isNoOpTaskSave
} = require('../caldav/parser');

test.describe('Issue #302 — DTSTART + DURATION Task Preservation & Mutual Exclusion', () => {
  const TASK_WITH_DURATION_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar 1.0//EN',
    'BEGIN:VTODO',
    'UID:task-duration-302',
    'SUMMARY:Task with Duration',
    'STATUS:NEEDS-ACTION',
    'DTSTART:20260601T100000Z',
    'DURATION:PT2H',
    'END:VTODO',
    'END:VCALENDAR'
  ].join('\r\n');

  test('parseICSToTask extracts duration and calculates due date from DTSTART + DURATION', () => {
    const task = parseICSToTask(TASK_WITH_DURATION_ICS);
    assert.notEqual(task, null);
    assert.equal(task.uid, 'task-duration-302');
    assert.equal(task.dtstart, '2026-06-01T10:00:00.000Z');
    assert.equal(task.duration, 'PT2H');
    assert.equal(task.due, '2026-06-01T12:00:00.000Z', 'due should be computed as DTSTART + DURATION');
  });

  test('taskToICS updating existing VTODO with DURATION preserves DURATION and excludes DUE', () => {
    const task = parseICSToTask(TASK_WITH_DURATION_ICS);
    const updatedIcs = taskToICS(task, TASK_WITH_DURATION_ICS);

    assert.ok(updatedIcs.includes('DURATION:PT2H'), 'Updated ICS must preserve DURATION:PT2H');
    assert.ok(updatedIcs.includes('DTSTART:20260601T100000Z'), 'Updated ICS must preserve DTSTART');
    assert.ok(!updatedIcs.includes('DUE:'), 'Updated ICS MUST NOT contain DUE property when DURATION is present (RFC 5545 mutual exclusion)');
  });

  test('taskToICS fallback generation for task with duration emits DURATION and excludes DUE', () => {
    const task = {
      uid: 'task-new-duration',
      title: 'New Duration Task',
      status: 'NEEDS-ACTION',
      dtstart: '2026-06-01T10:00:00.000Z',
      duration: 'PT2H',
      due: '2026-06-01T12:00:00.000Z'
    };
    const generatedIcs = taskToICS(task);

    assert.ok(generatedIcs.includes('DURATION:PT2H'), 'Generated ICS must contain DURATION');
    assert.ok(!generatedIcs.includes('DUE:'), 'Generated ICS MUST NOT contain DUE property when DURATION is set');
  });

  test('5 consecutive zero-edit save cycles preserve DURATION and DTSTART losslessly', () => {
    let currentIcs = TASK_WITH_DURATION_ICS;
    for (let i = 0; i < 5; i++) {
      const parsed = parseICSToTask(currentIcs);
      assert.equal(parsed.duration, 'PT2H', `Cycle ${i+1}: parsed duration must be PT2H`);
      assert.equal(parsed.due, '2026-06-01T12:00:00.000Z', `Cycle ${i+1}: parsed due must match calculated due`);
      currentIcs = taskToICS(parsed, currentIcs);
      assert.ok(currentIcs.includes('DURATION:PT2H'), `Cycle ${i+1}: output ICS must retain DURATION:PT2H`);
      assert.ok(!currentIcs.includes('DUE:'), `Cycle ${i+1}: output ICS MUST NOT contain DUE`);
    }
  });

  test('isNoOpTaskSave detects zero-edit save for task with DURATION', () => {
    const parsed = parseICSToTask(TASK_WITH_DURATION_ICS);
    const isNoOp = isNoOpTaskSave(TASK_WITH_DURATION_ICS, parsed);
    assert.equal(isNoOp, true, 'isNoOpTaskSave must return true for identical task payload with DURATION');
  });
});
