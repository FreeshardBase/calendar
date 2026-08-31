'use strict';

/**
 * Issue #93 — HIGH: a date-only DUE becomes a timed deadline, and under a
 * non-UTC server it moves to the previous day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseVTodoToTask, taskToICS } = require('../caldav/parser');

test('Issue #93 — Date-only DUE parsing and serialization under non-UTC process timezone', async (t) => {

  await t.test('parseVTodoToTask extracts date-only DUE without timezone date shifting', () => {
    const rawIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-due-date-123@freeshard',
      'SUMMARY:Buy groceries',
      'DUE;VALUE=DATE:20260902',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const jcal = ICAL.parse(rawIcs);
    const comp = new ICAL.Component(jcal);
    const vtodo = comp.getFirstSubcomponent('vtodo');

    const task = parseVTodoToTask(vtodo, rawIcs);

    assert.equal(task.dueIsDate, true, 'task.dueIsDate must be true for VALUE=DATE');
    assert.equal(task.due, '2026-09-02T00:00:00.000Z', 'due must be UTC midnight on 2026-09-02, not shifted to 2026-09-01');
  });

  await t.test('taskToICS serializes date-only DUE preserving VALUE=DATE and correct date', () => {
    const task = {
      uid: 'task-due-date-123@freeshard',
      title: 'Buy groceries',
      status: 'NEEDS-ACTION',
      due: '2026-09-02T00:00:00.000Z',
      dueIsDate: true
    };

    const generatedIcs = taskToICS(task);
    assert.ok(generatedIcs.includes('DUE;VALUE=DATE:20260902'), `ICS must include DUE;VALUE=DATE:20260902, got: ${generatedIcs}`);
    assert.ok(!generatedIcs.includes('DUE:20260901'), 'ICS must not contain shifted previous day 20260901');
  });

  await t.test('taskToICS updating existing VTODO preserves date-only VALUE=DATE', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-due-date-123@freeshard',
      'SUMMARY:Buy groceries',
      'DUE;VALUE=DATE:20260902',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedTask = {
      uid: 'task-due-date-123@freeshard',
      title: 'Buy organic groceries',
      status: 'NEEDS-ACTION',
      due: '2026-09-02T00:00:00.000Z',
      dueIsDate: true,
      rawIcs: existingIcs
    };

    const resultIcs = taskToICS(updatedTask, existingIcs);
    assert.ok(resultIcs.includes('DUE;VALUE=DATE:20260902'), `Updated ICS must maintain DUE;VALUE=DATE:20260902, got: ${resultIcs}`);
  });

  await t.test('dtstart;VALUE=DATE parsing and serialization preserves date-only', () => {
    const rawIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Freeshard//WebCalendar 1.0//EN',
      'BEGIN:VTODO',
      'UID:task-dtstart-date-456@freeshard',
      'SUMMARY:Start project',
      'DTSTART;VALUE=DATE:20261015',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const jcal = ICAL.parse(rawIcs);
    const comp = new ICAL.Component(jcal);
    const vtodo = comp.getFirstSubcomponent('vtodo');

    const task = parseVTodoToTask(vtodo, rawIcs);
    assert.equal(task.dtstartIsDate, true, 'dtstartIsDate must be true');
    assert.equal(task.dtstart, '2026-10-15T00:00:00.000Z', 'dtstart must be 2026-10-15 UTC midnight');

    const resultIcs = taskToICS(task);
    assert.ok(resultIcs.includes('DTSTART;VALUE=DATE:20261015'), `Result must include DTSTART;VALUE=DATE:20261015, got: ${resultIcs}`);
  });
});
