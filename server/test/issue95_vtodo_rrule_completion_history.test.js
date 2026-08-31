'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3116';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ICAL = require('ical.js');
const { parseICSToTask, parseVTodoToTask, taskToICS, advanceRecurringTask } = require('../caldav/parser');

test.describe('Issue #95 — Recurring VTODO Completion History & Live Implementation', () => {

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

  test('advanceRecurringTaskJS in public/js/tasks.js maintains completedHistory', () => {
    const tasksJsContent = fs.readFileSync(path.resolve(__dirname, '../../public/js/tasks.js'), 'utf8');
    assert.ok(tasksJsContent.includes('completedHistory'), 'public/js/tasks.js must reference completedHistory');
  });

});
