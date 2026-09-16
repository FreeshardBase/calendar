'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3264';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { parseICSToTask, taskToICS, advanceRecurringTask } = require('../caldav/parser');

test.describe('Issue #264 — Recurring Task Completion & Server Coherence', () => {

  test('advanceRecurringTask preserves provided completed timestamp if present', () => {
    const task = {
      uid: 'task-rec-completed-1',
      title: 'Weekly Sync',
      recurrence: 'FREQ=WEEKLY',
      due: '2026-09-01T10:00:00.000Z',
      status: 'COMPLETED',
      completed: '2026-09-01T10:30:00.000Z',
      completedHistory: []
    };

    const advanced = advanceRecurringTask(task);
    assert.ok(advanced);
    assert.strictEqual(advanced.status, 'NEEDS-ACTION');
    assert.strictEqual(advanced.completed, null);
    assert.strictEqual(advanced.percentComplete, 0);
    assert.ok(Array.isArray(advanced.completedHistory));
    assert.strictEqual(advanced.completedHistory.length, 1);
    assert.strictEqual(advanced.completedHistory[0], '2026-09-01T10:30:00.000Z');
  });

  test('taskToICS writes X-COMPLETED-DATES and clears COMPLETED timestamp when advancing recurring task', () => {
    const existingIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Freeshard//WebCalendar 1.0//EN
BEGIN:VTODO
UID:task-rec-completed-2
SUMMARY:Daily Standup
RRULE:FREQ=DAILY
DUE:20260901T090000Z
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`;

    const fullTask = parseICSToTask(existingIcs);
    assert.ok(fullTask);

    const advanced = advanceRecurringTask({
      ...fullTask,
      status: 'COMPLETED',
      completed: '2026-09-01T09:15:00.000Z'
    });
    assert.ok(advanced);

    const updatedIcs = taskToICS(advanced, existingIcs);
    assert.ok(updatedIcs.includes('STATUS:NEEDS-ACTION'));
    assert.ok(updatedIcs.includes('X-COMPLETED-DATES:2026-09-01T09:15:00.000Z'));
    assert.ok(!updatedIcs.includes('COMPLETED:'));

    const reParsed = parseICSToTask(updatedIcs);
    assert.ok(reParsed);
    assert.strictEqual(reParsed.status, 'NEEDS-ACTION');
    assert.strictEqual(reParsed.completed, null);
    assert.deepEqual(reParsed.completedHistory, ['2026-09-01T09:15:00.000Z']);
  });

  test('server/routes/tasks.js imports parseICSToTask and advanceRecurringTask correctly', () => {
    const tasksRouter = require('../routes/tasks');
    assert.ok(tasksRouter, 'tasks router must be importable');
  });
});
