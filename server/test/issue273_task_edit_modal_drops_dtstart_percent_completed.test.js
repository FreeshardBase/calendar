'use strict';
process.env.NODE_ENV = 'test';

// The task dialog's part of #273 (an edit keeps DTSTART, PERCENT-COMPLETE and the completions) is
// driven in the browser: e2e/calendar.spec.js, "Issue #273 — editing a task keeps ...".
const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Issue #273 — Task Edit Modal Preservation of DTSTART, PERCENT-COMPLETE and COMPLETED', () => {
  it('the task parser keeps dtstart, percentComplete and completed through reconcile, serialise and parse', async () => {
    const { parseICSToTask, taskToICS, reconcileTaskStatus } = require('../../server/caldav/parser');

    const rawTask = {
      uid: 'task-777',
      title: 'Server Task Preservation',
      status: 'IN-PROCESS',
      due: '2026-10-01T12:00:00.000Z',
      dtstart: '2026-09-01T08:00:00.000Z',
      priority: 1,
      percentComplete: 45,
      completed: null
    };

    const reconciled = reconcileTaskStatus(rawTask);
    assert.strictEqual(reconciled.dtstart, '2026-09-01T08:00:00.000Z');
    assert.strictEqual(reconciled.percentComplete, 45);
    assert.strictEqual(reconciled.status, 'IN-PROCESS');

    const ics = taskToICS(reconciled);
    assert.ok(ics.includes('DTSTART:20260901T080000Z'), 'ICS must contain DTSTART');
    assert.ok(ics.includes('PERCENT-COMPLETE:45'), 'ICS must contain PERCENT-COMPLETE');

    const parsed = parseICSToTask(ics);
    assert.strictEqual(parsed.dtstart, '2026-09-01T08:00:00.000Z');
    assert.strictEqual(parsed.percentComplete, 45);
  });
});
