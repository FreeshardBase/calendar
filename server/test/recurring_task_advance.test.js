'use strict';

/**
 * Issue #64 — HIGH: recurring tasks advance by hand-rolled arithmetic
 * that ignores BYDAY, COUNT and UNTIL.
 *
 * Fix: advanceRecurringTask must use ICAL.Recur + iterator to find the
 * first occurrence strictly after the task's current due date, honoring
 * all RRULE parts (BYDAY, INTERVAL, COUNT, UNTIL).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { advanceRecurringTask } = require('../caldav/parser');

test.describe('Issue #64 — advanceRecurringTask RRULE fidelity', () => {

  // ── BYDAY ────────────────────────────────────────────────────────────────

  test('FREQ=WEEKLY;BYDAY=MO advances to the next Monday, not +7 days from any weekday', () => {
    // 2026-08-10 is a Monday; next occurrence via BYDAY=MO is 2026-08-17 (Mon)
    const task = {
      uid: 'task-byday-mo',
      title: 'Weekly Monday Task',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z', // Monday
      recurrence: 'FREQ=WEEKLY;BYDAY=MO'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.equal(advanced.completed, null);
    // Must land on a Monday
    const nextDue = new Date(advanced.due);
    assert.equal(nextDue.getUTCDay(), 1, 'next due must be a Monday (UTC)');
    // Must be exactly one week later
    assert.ok(advanced.due.startsWith('2026-08-17'), `expected 2026-08-17, got ${advanced.due}`);
  });

  test('FREQ=WEEKLY;BYDAY=MO,WE,FR from a Wednesday advances to Friday', () => {
    // 2026-08-12 is a Wednesday; next BYDAY=MO,WE,FR occurrence is 2026-08-14 (Fri)
    const task = {
      uid: 'task-byday-mwf',
      title: 'MWF Task',
      status: 'COMPLETED',
      due: '2026-08-12T09:00:00.000Z', // Wednesday
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    const nextDue = new Date(advanced.due);
    // Friday is day 5
    assert.equal(nextDue.getUTCDay(), 5, `expected Friday (5), got ${nextDue.getUTCDay()}`);
    assert.ok(advanced.due.startsWith('2026-08-14'), `expected 2026-08-14, got ${advanced.due}`);
  });

  test('FREQ=MONTHLY;BYDAY=2MO advances to the 2nd Monday of next month', () => {
    // 2026-08-10 = 2nd Monday of August; next is 2nd Monday of September 2026 = 2026-09-14
    const task = {
      uid: 'task-byday-monthly-mo',
      title: '2nd Monday Monthly',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=MONTHLY;BYDAY=2MO'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-09-14'), `expected 2026-09-14, got ${advanced.due}`);
  });

  // ── COUNT ────────────────────────────────────────────────────────────────

  test('returns null when COUNT is exhausted (no occurrences remain)', () => {
    // FREQ=DAILY;COUNT=3 starting 2026-08-08: occurrences are Aug 8, 9, 10.
    // Completing the last occurrence (Aug 10) means COUNT is exhausted.
    const task = {
      uid: 'task-count-exhausted',
      title: 'Count-Limited Task',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z', // 3rd and final occurrence
      recurrence: 'FREQ=DAILY;COUNT=3',
      dtstart: '2026-08-08T09:00:00.000Z'
    };
    const advanced = advanceRecurringTask(task);
    // No next occurrence: must return null (or undefined) to signal exhaustion
    assert.equal(advanced, null, 'exhausted COUNT series must return null');
  });

  test('COUNT not exhausted: advances when there is a remaining occurrence', () => {
    // FREQ=DAILY;COUNT=5 starting Aug 8: occurrences Aug 8-12.
    // Completing occurrence on Aug 9 (index 2 of 5), next is Aug 10.
    const task = {
      uid: 'task-count-remaining',
      title: 'Count Task with Remaining',
      status: 'COMPLETED',
      due: '2026-08-09T09:00:00.000Z', // 2nd of 5 occurrences
      recurrence: 'FREQ=DAILY;COUNT=5',
      dtstart: '2026-08-08T09:00:00.000Z'
    };
    const advanced = advanceRecurringTask(task);
    assert.notEqual(advanced, null);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-08-10'), `expected 2026-08-10, got ${advanced.due}`);
  });

  // ── UNTIL ────────────────────────────────────────────────────────────────

  test('returns null when next occurrence would exceed UNTIL', () => {
    // FREQ=DAILY;UNTIL=20260811T000000Z: last occurrence is Aug 10.
    // Completing Aug 10 means the series is done.
    const task = {
      uid: 'task-until-exhausted',
      title: 'Until-Limited Task',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=DAILY;UNTIL=20260811T000000Z'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced, null, 'exhausted UNTIL series must return null');
  });

  test('UNTIL not reached: advances to the next in-range occurrence', () => {
    // FREQ=DAILY;UNTIL=20260815T000000Z: completing Aug 10, next is Aug 11.
    const task = {
      uid: 'task-until-remaining',
      title: 'Until Task with Remaining',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=DAILY;UNTIL=20260815T000000Z'
    };
    const advanced = advanceRecurringTask(task);
    assert.notEqual(advanced, null);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-08-11'), `expected 2026-08-11, got ${advanced.due}`);
  });

  // ── Backward-compatibility: simple FREQ still works ──────────────────────

  test('FREQ=DAILY with no BYDAY/COUNT/UNTIL still advances by one day', () => {
    const task = {
      uid: 'task-daily-simple',
      title: 'Daily Simple',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=DAILY'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-08-11'), `expected 2026-08-11, got ${advanced.due}`);
  });

  test('FREQ=WEEKLY with no BYDAY still advances by exactly 7 days', () => {
    const task = {
      uid: 'task-weekly-simple',
      title: 'Weekly Simple',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z', // Monday
      recurrence: 'FREQ=WEEKLY'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-08-17'), `expected 2026-08-17, got ${advanced.due}`);
  });

  test('FREQ=MONTHLY advances by one month', () => {
    const task = {
      uid: 'task-monthly-simple',
      title: 'Monthly Simple',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=MONTHLY'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-09-10'), `expected 2026-09-10, got ${advanced.due}`);
  });

  test('FREQ=YEARLY advances by one year', () => {
    const task = {
      uid: 'task-yearly-simple',
      title: 'Yearly Simple',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=YEARLY'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2027-08-10'), `expected 2027-08-10, got ${advanced.due}`);
  });

  test('INTERVAL=2 with FREQ=WEEKLY advances by 14 days', () => {
    const task = {
      uid: 'task-biweekly',
      title: 'Biweekly Task',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;INTERVAL=2'
    };
    const advanced = advanceRecurringTask(task);
    assert.equal(advanced.status, 'NEEDS-ACTION');
    assert.ok(advanced.due.startsWith('2026-08-24'), `expected 2026-08-24, got ${advanced.due}`);
  });

  test('null task input returns null gracefully', () => {
    assert.equal(advanceRecurringTask(null), null);
  });

  test('task without recurrence returns null (non-recurring, no next occurrence)', () => {
    const task = {
      uid: 'task-no-recur',
      title: 'One-shot',
      status: 'COMPLETED',
      due: '2026-08-10T09:00:00.000Z',
      recurrence: null
    };
    // Original code returned the task unchanged; new contract: null = no next occurrence
    const result = advanceRecurringTask(task);
    assert.equal(result, null);
  });

});
