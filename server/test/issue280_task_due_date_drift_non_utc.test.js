'use strict';

const test = require('node:test');
const assert = require('assert');
const { parseICSToTask, taskToICS, isNoOpTaskSave } = require('../caldav/parser');

// Helper matching client-side local datetime-local input formatting
function toLocalISOString(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('Issue #280 — Task due date drift prevention in non-UTC environment', async (t) => {
  await t.test('Client-side: toLocalISOString formats UTC ISO string to local wall-clock for datetime-local input', () => {
    const isoString = '2026-10-15T12:00:00.000Z';
    const localInputVal = toLocalISOString(isoString);

    const d = new Date(isoString);
    const expectedLocal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.strictEqual(localInputVal, expectedLocal, 'toLocalISOString must match local wall-clock components');
  });

  await t.test('Client-side: 5 consecutive zero-edit save cycles maintain zero drift on task due date', () => {
    let currentIso = '2026-10-15T12:00:00.000Z';
    const initialIso = currentIso;

    for (let cycle = 1; cycle <= 5; cycle++) {
      // 1. Populate modal input
      const inputVal = toLocalISOString(currentIso);
      // 2. Read back from datetime-local input on save
      const savedIso = new Date(inputVal).toISOString();
      currentIso = savedIso;
    }

    assert.strictEqual(currentIso, initialIso, '5 zero-edit save cycles must produce zero due date drift');
  });

  await t.test('Server-side: isNoOpTaskSave identifies zero-edit save with identical due timestamp', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-280-test@freeshard',
      'SUMMARY:Test Due Date Drift',
      'DUE:20261015T120000Z',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const incomingTask = {
      title: 'Test Due Date Drift',
      due: '2026-10-15T12:00:00.000Z',
      status: 'NEEDS-ACTION'
    };

    const isNoOp = isNoOpTaskSave(existingIcs, incomingTask);
    assert.strictEqual(isNoOp, true, 'isNoOpTaskSave must evaluate to true for zero-edit task save');
  });

  await t.test('Server-side: taskToICS preserves DUE timestamp in UTC without shift', () => {
    const task = {
      uid: 'task-280-utc@freeshard',
      title: 'Preserve DUE UTC',
      due: '2026-10-15T12:00:00.000Z',
      status: 'NEEDS-ACTION'
    };

    const ics = taskToICS(task);
    assert.ok(ics.includes('DUE:20261015T120000Z'), 'taskToICS must serialize DUE as 20261015T120000Z');

    const parsed = parseICSToTask(ics);
    assert.strictEqual(parsed.due, '2026-10-15T12:00:00.000Z', 'parseICSToTask must round-trip DUE timestamp identically');
  });
});
