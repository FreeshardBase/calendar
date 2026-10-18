'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileTaskStatus, taskToICS, parseICSToTask } = require('../caldav/parser');

// Issue #499: the board has a "Abgebrochen" lane. Dropping a task there must store
// STATUS:CANCELLED, whatever progress the task had, and drop a COMPLETED date.
test('Issue #499 — an explicit CANCELLED status survives reconciliation', async (t) => {
  await t.test('a task in progress that is cancelled keeps CANCELLED and its progress', () => {
    const reconciled = reconcileTaskStatus({ title: 'testuser task', status: 'CANCELLED', percentComplete: 40 });
    assert.equal(reconciled.status, 'CANCELLED');
    assert.equal(reconciled.percentComplete, 40);
    assert.equal(reconciled.completed, null);
  });

  await t.test('a finished task that is cancelled loses its COMPLETED date', () => {
    const reconciled = reconcileTaskStatus({
      title: 'testuser task', status: 'CANCELLED', percentComplete: 100, completed: '2036-08-11T09:00:00.000Z',
    });
    assert.equal(reconciled.status, 'CANCELLED');
    assert.equal(reconciled.completed, null);
  });

  await t.test('the stored VTODO says CANCELLED and reads back as CANCELLED', () => {
    const ics = taskToICS(reconcileTaskStatus({ uid: 'testuser-499', title: 'testuser task', status: 'CANCELLED', percentComplete: 60 }));
    assert.match(ics, /^STATUS:CANCELLED\r?$/m);
    assert.doesNotMatch(ics, /^COMPLETED:/m);
    assert.equal(parseICSToTask(ics).status, 'CANCELLED');
  });
});
