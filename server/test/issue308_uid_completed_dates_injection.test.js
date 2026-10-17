'use strict';
require('./helpers/sameOriginFetch');
// #524: the stub CalDAV server of linked accounts listens on 127.0.0.1; allow it like an operator would.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

/**
 * Issue #308 remainder — the two raw interpolations left in taskToICS:
 * `UID:${uid}` in the fallback builder (reachable via PUT /api/tasks/:uid with a
 * `uid` in the body) and `X-COMPLETED-DATES` in both builders. Measured as the
 * issue specifies: by counting top-level property names inside the VTODO.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue308-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue308.db');
process.env.ENCRYPTION_KEY = 'issue308-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ICAL = require('ical.js');
const { taskToICS, parseICSToTask } = require('../caldav/parser');
const tasksRouter = require('../routes/tasks');

const INJECTED_ATTENDEE = '\r\nATTENDEE;CUTYPE=INDIVIDUAL:mailto:testuser@example.com';
const INJECTED_ORGANIZER = '\r\nORGANIZER:mailto:testuser@example.com';

function vtodoPropNames(ics) {
  const vtodo = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vtodo');
  return vtodo.getAllProperties().map((p) => p.name.toUpperCase());
}

test('fallback builder: an injected UID does not create a new top-level property', () => {
  const ics = taskToICS({ uid: 'testuser-task' + INJECTED_ATTENDEE, title: 'Test User task' });
  const names = vtodoPropNames(ics);
  assert.ok(!names.includes('ATTENDEE'), 'no ATTENDEE expected, got ' + names);
  assert.equal(names.filter((n) => n === 'UID').length, 1);
});

test('control: a plain UID survives the fallback builder unchanged', () => {
  const ics = taskToICS({ uid: 'testuser-task-1', title: 'Test User task' });
  assert.equal(parseICSToTask(ics).uid, 'testuser-task-1');
});

const HISTORY_INJECTED = ['2026-01-01T00:00:00.000Z' + INJECTED_ORGANIZER];

test('fallback builder: an injected completedHistory entry does not create a new top-level property', () => {
  const ics = taskToICS({ uid: 'testuser-task-2', title: 'Test User task', completedHistory: HISTORY_INJECTED });
  const names = vtodoPropNames(ics);
  assert.ok(!names.includes('ORGANIZER'), 'no ORGANIZER expected, got ' + names);
});

test('ICAL.js builder: an injected completedHistory entry does not create a new top-level property', () => {
  const base = taskToICS({ uid: 'testuser-task-3', title: 'Test User task' });
  const ics = taskToICS({ uid: 'testuser-task-3', title: 'Test User task', completedHistory: HISTORY_INJECTED }, base);
  const names = vtodoPropNames(ics);
  assert.ok(!names.includes('ORGANIZER'), 'no ORGANIZER expected, got ' + names);
});

test('control: valid completedHistory entries round-trip through both builders', () => {
  const history = ['2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z'];
  const fresh = taskToICS({ uid: 'testuser-task-4', title: 'Test User task', completedHistory: history });
  assert.deepEqual(parseICSToTask(fresh).completedHistory, history);
  const updated = taskToICS({ uid: 'testuser-task-4', title: 'Test User task', completedHistory: history }, fresh);
  assert.deepEqual(parseICSToTask(updated).completedHistory, history);
});

test('PUT /api/tasks/:uid stores the path UID, not a CRLF-laden UID from the body', async () => {
  const puts = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'PUT') puts.push(body);
      res.writeHead(req.method === 'GET' ? 404 : 201, { 'Content-Type': 'text/calendar' });
      res.end(req.method === 'GET' ? 'Not Found' : '');
    });
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = 'http://127.0.0.1:' + dav.address().port + '/';

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { userId: 'testuser', accounts: [{ id: 'acc', authType: 'basic', url: davUrl, username: 'testuser', password: 'testuser-password' }] };
    next();
  });
  app.use('/api/tasks', tasksRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/tasks/testuser-target', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'acc::/testuser/cal/',
        href: '/testuser/cal/testuser-target.ics',
        uid: 'testuser-target' + INJECTED_ATTENDEE,
        title: 'Test User task',
      }),
    });
    assert.ok(res.status < 300, 'save must succeed, got ' + res.status + ' ' + (await res.text()));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => dav.close(resolve));
  }
  assert.equal(puts.length, 1, 'the task must be written once');
  const names = vtodoPropNames(puts[0]);
  assert.ok(!names.includes('ATTENDEE'), 'no ATTENDEE expected, got ' + names);
  assert.equal(parseICSToTask(puts[0]).uid, 'testuser-target');
});
