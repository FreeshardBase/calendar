'use strict';
// #311: POST/PUT /api/tasks must reject out-of-spec input with HTTP 400 at the route,
// before anything reaches CalDAV — not store it, and not surface it as an opaque 500.
require('./helpers/sameOriginFetch');
process.env.NODE_ENV = 'test';
process.env.PORT = '3412';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = process.env.CALDAVURL || `http://localhost:${process.env.PORT}/mock-dav/`;
process.env.CALDAV_USERNAME = process.env.CALDAV_USERNAME || 'test';
process.env.CALDAV_PASSWORD = process.env.CALDAV_PASSWORD || 'test';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { taskToICS } = require('../caldav/parser');

const baseUrl = `http://localhost:${process.env.PORT}`;
const calendarId = 'env-default::/mock-dav/calendars/test/personal/';
const headers = { 'Content-Type': 'application/json' };

async function postTask(body) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ calendarId, ...body })
  });
  return { status: res.status, body: await res.json() };
}

async function listTasks() {
  const res = await fetch(`${baseUrl}/api/tasks`, { headers });
  assert.equal(res.status, 200);
  return res.json();
}

test.describe('#311 POST/PUT /api/tasks route-level input validation', () => {
  test.before(async () => {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.listen(process.env.PORT, '127.0.0.1', err => (err ? reject(err) : resolve()));
      });
    }
    headers.cookie = await loginAs('test-issue311-user');
  });

  test.after(() => {
    server.close();
  });

  // One row per input from the issue table, plus the status/percentComplete cases.
  const rejected = [
    ['due = morgen', { title: 'testuser task', due: 'morgen' }, /due/i],
    ['recurrence = NONSENSE', { title: 'testuser task', recurrence: 'NONSENSE' }, /recurrence/i],
    ['recurrence = FREQ=FORTNIGHTLY', { title: 'testuser task', recurrence: 'FREQ=FORTNIGHTLY' }, /recurrence/i],
    ['priority = 99', { title: 'testuser task', priority: 99 }, /priority/i],
    ['priority = -1', { title: 'testuser task', priority: -1 }, /priority/i],
    ['percentComplete = 101', { title: 'testuser task', percentComplete: 101 }, /percentComplete/i],
    ['status = BANANA', { title: 'testuser task', status: 'BANANA' }, /status/i],
    ['status = banana', { title: 'testuser task', status: 'banana' }, /status/i],
    ['status = X-WHATEVER', { title: 'testuser task', status: 'X-WHATEVER' }, /status/i],
    ['status = DROP-TABLE-TASKS', { title: 'testuser task', status: 'DROP-TABLE-TASKS' }, /status/i]
  ];

  for (const [label, body, pattern] of rejected) {
    test(`POST ${label} -> 400 and nothing stored`, async () => {
      const marker = `testuser-311-${label}`;
      const res = await postTask({ ...body, title: marker });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, pattern);
      const tasks = await listTasks();
      assert.ok(!tasks.some(t => t.title === marker), 'rejected task must not be stored');
    });
  }

  const accepted = [
    ['due = empty string', { title: 'testuser-311-empty-due', due: '' }, 'NEEDS-ACTION'],
    ['no title at all', {}, 'NEEDS-ACTION'],
    ['status = in-process (lowercase)', { title: 'testuser-311-lower', status: 'in-process' }, 'IN-PROCESS'],
    ['status = CANCELLED', { title: 'testuser-311-cancelled', status: 'CANCELLED' }, 'CANCELLED'],
    ['priority = 9', { title: 'testuser-311-prio9', priority: 9 }, 'NEEDS-ACTION']
  ];

  for (const [label, body, expectedStatus] of accepted) {
    test(`POST ${label} -> 201 and stored`, async () => {
      const res = await postTask(body);
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.status, expectedStatus);
      const tasks = await listTasks();
      const stored = tasks.find(t => t.uid === res.body.uid);
      assert.ok(stored, 'accepted task must be stored');
      assert.equal(stored.status, expectedStatus);
    });
  }

  test('PUT with status BANANA on an existing task -> 400 and stored status unchanged', async () => {
    const created = await postTask({ title: 'testuser-311-put' });
    assert.equal(created.status, 201);

    const res = await fetch(`${baseUrl}/api/tasks/${created.body.uid}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        calendarId,
        href: created.body.href,
        etag: created.body.etag,
        status: 'BANANA'
      })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /status/i);

    const stored = (await listTasks()).find(t => t.uid === created.body.uid);
    assert.equal(stored.status, 'NEEDS-ACTION');
  });

  test('taskToICS never serialises a STATUS outside RFC 5545 VTODO values', () => {
    const ics = taskToICS({ uid: 'testuser-311-ics', title: 'x', status: 'BANANA' });
    assert.doesNotMatch(ics, /STATUS:BANANA/);
  });
});
