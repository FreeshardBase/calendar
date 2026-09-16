const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToTask, taskToICS, isNoOpTaskSave } = require('../caldav/parser');

test('Issue #281 - All-day task (DUE;VALUE=DATE) preservation and timezone stability', async (t) => {
  await t.test('parseICSToTask extracts dueIsDate=true and UTC midnight ISO string', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-allday-1',
      'SUMMARY:All Day Task',
      'DUE;VALUE=DATE:20260910',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    assert.equal(task.dueIsDate, true, 'task.dueIsDate must be true for VALUE=DATE');
    assert.equal(task.due, '2026-09-10T00:00:00.000Z', 'task.due must be UTC midnight ISO string');
  });

  await t.test('taskToICS preserves DUE;VALUE=DATE across zero-edit saves in non-UTC timezones', () => {
    const origTz = process.env.TZ;
    const testTimezones = ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Pacific/Honolulu'];

    try {
      for (const tz of testTimezones) {
        process.env.TZ = tz;
        let ics = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VTODO',
          'UID:task-allday-tz',
          'SUMMARY:All Day Task TZ',
          'DUE;VALUE=DATE:20260910',
          'END:VTODO',
          'END:VCALENDAR'
        ].join('\r\n');

        for (let save = 1; save <= 3; save++) {
          const task = parseICSToTask(ics);
          assert.equal(task.dueIsDate, true, `Save ${save} in ${tz}: dueIsDate must be true`);
          assert.equal(task.due, '2026-09-10T00:00:00.000Z', `Save ${save} in ${tz}: due must remain 2026-09-10T00:00:00.000Z`);

          // Simulate frontend formatting & saving logic for all-day task
          const d = new Date(task.due);
          const pad = (n) => String(n).padStart(2, '0');
          const inputVal = task.dueIsDate
            ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`
            : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

          let dueISO = null;
          let dueIsDate = false;
          if (inputVal) {
            if (task.dueIsDate) {
              dueIsDate = true;
              dueISO = `${inputVal.split('T')[0]}T00:00:00.000Z`;
            } else {
              dueISO = new Date(inputVal).toISOString();
            }
          }

          const taskData = {
            ...task,
            due: dueISO,
            dueIsDate
          };

          const isNoOp = isNoOpTaskSave(ics, taskData);
          assert.equal(isNoOp, true, `Save ${save} in ${tz}: isNoOpTaskSave must be true for zero-edit save`);

          ics = taskToICS(taskData, ics);
          const reParsed = parseICSToTask(ics);
          assert.equal(reParsed.dueIsDate, true, `Save ${save} in ${tz}: reParsed dueIsDate must be true`);
          assert.equal(reParsed.due, '2026-09-10T00:00:00.000Z', `Save ${save} in ${tz}: reParsed due must remain 2026-09-10T00:00:00.000Z`);
          assert.match(ics, /DUE;VALUE=DATE:20260910/, `Save ${save} in ${tz}: output ICS must contain DUE;VALUE=DATE:20260910`);
        }
      }
    } finally {
      process.env.TZ = origTz;
    }
  });

  await t.test('Editing all-day task due date updates DUE;VALUE=DATE without date-ness loss', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-allday-edit',
      'SUMMARY:All Day Task Edit',
      'DUE;VALUE=DATE:20260910',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(ics);
    const updatedTask = {
      ...task,
      due: '2026-09-25T00:00:00.000Z',
      dueIsDate: true
    };

    const newIcs = taskToICS(updatedTask, ics);
    assert.match(newIcs, /DUE;VALUE=DATE:20260925/, 'ICS must contain updated DUE;VALUE=DATE:20260925');

    const reParsed = parseICSToTask(newIcs);
    assert.equal(reParsed.dueIsDate, true, 'reParsed dueIsDate must be true');
    assert.equal(reParsed.due, '2026-09-25T00:00:00.000Z', 'reParsed due must be 2026-09-25T00:00:00.000Z');
  });
});
