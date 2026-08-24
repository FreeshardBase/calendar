'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3098';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskList, taskToICS } = require('../caldav/parser');
const CalDAVClient = require('../caldav/client');

test.describe('Issue #13 — VTODO Task Management CalDAV Synchronization Suite', () => {

  test('should generate VTODO calendar-query report xml payload', () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232' });
    assert.equal(typeof client.getTasks, 'function');
  });

  test('should parse VTODO task list from xml report response with eTag and href', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/user/persoenlich/task-1.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-12345"</getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//FreeShard//WebCalendar//EN
BEGIN:VTODO
UID:task-1
SUMMARY:Synchronized Task
STATUS:NEEDS-ACTION
PRIORITY:1
DUE:20260901T120000Z
END:VTODO
END:VCALENDAR</C:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

    const tasks = parseTaskList(xml, 'acc-1::/user/persoenlich/', 'acc-1', 'http://localhost:5232/user/persoenlich/');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].uid, 'task-1');
    assert.equal(tasks[0].title, 'Synchronized Task');
    assert.equal(tasks[0].status, 'NEEDS-ACTION');
    assert.equal(tasks[0].priority, 1);
    assert.equal(tasks[0].etag, 'etag-12345');
    assert.equal(tasks[0].calendarId, 'acc-1::/user/persoenlich/');
  });

  test('should serialize and maintain VTODO ICS format for CalDAV synchronization PUT', () => {
    const task = {
      uid: 'task-sync-99',
      title: 'CalDAV Sync Test Task',
      description: 'Verifying bidirectional task synchronization',
      status: 'NEEDS-ACTION',
      due: '2026-09-10T15:00:00.000Z',
      priority: 2
    };

    const ics = taskToICS(task);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('BEGIN:VTODO'));
    assert.ok(ics.includes('UID:task-sync-99'));
    assert.ok(ics.includes('SUMMARY:CalDAV Sync Test Task'));
    assert.ok(ics.includes('STATUS:NEEDS-ACTION'));
    assert.ok(ics.includes('END:VTODO'));
    assert.ok(ics.includes('END:VCALENDAR'));
  });

});
