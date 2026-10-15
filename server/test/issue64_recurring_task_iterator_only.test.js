'use strict';

/**
 * Issue #64 — recurring tasks must advance through the ical.js iterator only.
 *
 * The browser no longer computes the next occurrence (it posts
 * status: 'COMPLETED' and the server advances), so the server function is the
 * single live path. Two defects remained there:
 *
 *  1. An RRULE ical.js cannot parse fell back to hand-rolled arithmetic
 *     (anything unknown advanced by one day) instead of failing loudly.
 *  2. The iterator was anchored at DTSTART but compared with DUE, so a task
 *     whose start and deadline differ (start 08:00, due 17:00) got its next
 *     DUE moved onto the start time (08:00) — the wrong date-time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { advanceRecurringTask } = require('../caldav/parser');

function task(overrides) {
  return { uid: 'task-64', title: 'Test task', status: 'COMPLETED', ...overrides };
}

test.describe('Issue #64 — advanceRecurringTask: iterator only, DUE is the recurring instance', () => {
  test('FREQ=DAILY with DTSTART 08:00 and DUE 17:00 keeps both times on the next day', () => {
    const advanced = advanceRecurringTask(task({
      dtstart: '2026-04-06T08:00:00.000Z',
      due: '2026-04-06T17:00:00.000Z',
      recurrence: 'FREQ=DAILY'
    }));
    assert.equal(advanced.due, '2026-04-07T17:00:00.000Z');
    assert.equal(advanced.dtstart, '2026-04-07T08:00:00.000Z');
  });

  test('FREQ=WEEKLY;BYDAY=MO,WE,FR with DTSTART before DUE advances Mon -> Wed at the due time', () => {
    const advanced = advanceRecurringTask(task({
      dtstart: '2026-04-06T08:00:00.000Z', // Monday
      due: '2026-04-06T17:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
    }));
    assert.equal(advanced.due, '2026-04-08T17:00:00.000Z');
    assert.equal(advanced.dtstart, '2026-04-08T08:00:00.000Z');
  });

  test('FREQ=MONTHLY from a month end with DTSTART before DUE skips February and lands on 31 March', () => {
    const advanced = advanceRecurringTask(task({
      dtstart: '2026-01-31T08:00:00.000Z',
      due: '2026-01-31T17:00:00.000Z',
      recurrence: 'FREQ=MONTHLY'
    }));
    assert.equal(advanced.due, '2026-03-31T17:00:00.000Z');
    assert.equal(advanced.dtstart, '2026-03-31T08:00:00.000Z');
  });

  test('FREQ=DAILY;COUNT=2 with DTSTART before DUE recurs once, then ends', () => {
    const first = advanceRecurringTask(task({
      dtstart: '2026-04-06T08:00:00.000Z',
      due: '2026-04-06T17:00:00.000Z',
      recurrence: 'FREQ=DAILY;COUNT=2'
    }));
    assert.equal(first.due, '2026-04-07T17:00:00.000Z');
    assert.equal(first.recurrence, 'FREQ=DAILY;COUNT=1');
    assert.equal(advanceRecurringTask({ ...first, status: 'COMPLETED' }), null);
  });

  test('FREQ=DAILY;UNTIL at the boundary ends the series', () => {
    const advanced = advanceRecurringTask(task({
      dtstart: '2026-04-07T08:00:00.000Z',
      due: '2026-04-07T17:00:00.000Z',
      recurrence: 'FREQ=DAILY;UNTIL=20260407T235959Z'
    }));
    assert.equal(advanced, null);
  });

  test('FREQ=MINUTELY;INTERVAL=30 advances by thirty minutes', () => {
    const advanced = advanceRecurringTask(task({
      due: '2026-08-10T09:00:00.000Z',
      recurrence: 'FREQ=MINUTELY;INTERVAL=30'
    }));
    assert.equal(advanced.due, '2026-08-10T09:30:00.000Z');
  });

  test('an RRULE ical.js rejects fails loudly instead of advancing by hand-rolled arithmetic', () => {
    assert.throws(
      () => advanceRecurringTask(task({ due: '2026-04-06T09:00:00.000Z', recurrence: 'FREQ=GARBAGE' })),
      (err) => err.status === 422
    );
  });

  test('DTSTART after DUE (invalid per RFC 5545) fails loudly with 422', () => {
    assert.throws(
      () => advanceRecurringTask(task({
        dtstart: '2026-04-07T08:00:00.000Z',
        due: '2026-04-06T17:00:00.000Z',
        recurrence: 'FREQ=DAILY'
      })),
      (err) => err.status === 422
    );
  });

  test('an RRULE without FREQ fails loudly with 422', () => {
    assert.throws(
      () => advanceRecurringTask(task({ due: '2026-04-06T09:00:00.000Z', recurrence: 'X-FOO=1' })),
      (err) => err.status === 422
    );
  });
});
