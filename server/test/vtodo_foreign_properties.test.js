'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToTask, taskToICS } = require('../caldav/parser');

test.describe('Issue #260 — VTODO Foreign Property Loss Prevention', () => {

  const foreignIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Foreign CalDAV Client//EN',
    'BEGIN:VTODO',
    'UID:task-foreign-260',
    'SUMMARY:Original Task Summary',
    'DESCRIPTION:Original Description',
    'STATUS:NEEDS-ACTION',
    'CATEGORIES:WORK,PROJECT-ALPHA',
    'LOCATION:Conference Room B',
    'ORGANIZER;CN=Test Organizer:mailto:testuser@example.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:testuser@example.com',
    'X-APPLE-SORT-ORDER:100',
    'X-NEXTCLOUD-COLOR:#ff0000',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Task Reminder',
    'END:VALARM',
    'END:VTODO',
    'END:VCALENDAR'
  ].join('\r\n');

  test('parseICSToTask attaches rawIcs to task object', () => {
    const task = parseICSToTask(foreignIcs, { calendarId: 'cal-1' });
    assert.equal(task.uid, 'task-foreign-260');
    assert.equal(task.title, 'Original Task Summary');
    assert.equal(task.rawIcs, foreignIcs);
  });

  test('taskToICS preserves foreign properties when updating an existing task', () => {
    const updatedTask = {
      uid: 'task-foreign-260',
      title: 'Updated Task Summary',
      status: 'COMPLETED',
      completed: '2026-08-24T12:00:00.000Z',
      percentComplete: 100
    };

    const resultIcs = taskToICS(updatedTask, foreignIcs);

    assert.ok(resultIcs.includes('SUMMARY:Updated Task Summary'), 'Summary should be updated');
    assert.ok(resultIcs.includes('STATUS:COMPLETED'), 'Status should be updated');
    assert.ok(resultIcs.includes('PERCENT-COMPLETE:100'), 'Percent complete should be set');
    assert.ok(resultIcs.includes('CATEGORIES:WORK,PROJECT-ALPHA'), 'CATEGORIES should be preserved');
    assert.ok(resultIcs.includes('LOCATION:Conference Room B'), 'LOCATION should be preserved');
    assert.ok(resultIcs.includes('ORGANIZER'), 'ORGANIZER should be preserved');
    assert.ok(resultIcs.includes('ATTENDEE'), 'ATTENDEE should be preserved');
    assert.ok(resultIcs.includes('X-APPLE-SORT-ORDER:100'), 'X-APPLE-SORT-ORDER should be preserved');
    assert.ok(resultIcs.includes('X-NEXTCLOUD-COLOR:#ff0000'), 'X-NEXTCLOUD-COLOR should be preserved');
    assert.ok(resultIcs.includes('BEGIN:VALARM'), 'VALARM subcomponent should be preserved');
    assert.ok(resultIcs.includes('PRODID:-//Foreign CalDAV Client//EN'), 'PRODID should be preserved');
  });

  test('taskToICS uses task.rawIcs when existingIcs argument is omitted', () => {
    const task = parseICSToTask(foreignIcs);
    task.title = 'Title via rawIcs';
    task.status = 'IN-PROCESS';

    const resultIcs = taskToICS(task);

    assert.ok(resultIcs.includes('SUMMARY:Title via rawIcs'));
    assert.ok(resultIcs.includes('STATUS:IN-PROCESS'));
    assert.ok(resultIcs.includes('CATEGORIES:WORK,PROJECT-ALPHA'));
    assert.ok(resultIcs.includes('X-APPLE-SORT-ORDER:100'));
  });

  test('taskToICS removes only specified null properties without dropping foreign fields', () => {
    const updatedTask = {
      uid: 'task-foreign-260',
      title: 'Original Task Summary',
      description: null, // Clear description
      status: 'NEEDS-ACTION'
    };

    const resultIcs = taskToICS(updatedTask, foreignIcs);

    assert.ok(!resultIcs.includes('DESCRIPTION:Original Description'), 'Description should be removed');
    assert.ok(resultIcs.includes('CATEGORIES:WORK,PROJECT-ALPHA'), 'CATEGORIES should be preserved');
    assert.ok(resultIcs.includes('X-APPLE-SORT-ORDER:100'), 'X-APPLE-SORT-ORDER should be preserved');
  });

});
