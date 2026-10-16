'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3290';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
server.listen(process.env.PORT);
const { loginAs } = require('./helpers/testSession');

test('Strict ACL Enforcement on Calendar & Event Routes (Issue #56)', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let strangerCookie = '';
  let readonlyUserCookie = '';

  const ownerUserId = 'test-owner-56';
  const strangerUserId = 'test-stranger-56';
  const readonlyUserId = 'test-readonly-56';

  await Db.upsertUser(ownerUserId, 'owner56@example.com');
  await Db.upsertUser(strangerUserId, 'stranger56@example.com');
  await Db.upsertUser(readonlyUserId, 'readonly56@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;
  const strangerCalId = `internal-caldav::/${strangerUserId}/personal/`;

  // Setup read-only share from owner to readonlyUser
  await Db.addUserShare(ownerCalId, readonlyUserId, false);

  await t.test('Authenticate sessions', async () => {
    ownerCookie = await loginAs(ownerUserId);
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res1.status, 200);

    strangerCookie = await loginAs(strangerUserId);
    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res2.status, 200);

    readonlyUserCookie = await loginAs(readonlyUserId);
    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: readonlyUserCookie }
    });
    assert.strictEqual(res3.status, 200);
  });

  await t.test('Unauthenticated GET /api/calendars/search-users should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/search-users?q=test`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthenticated POST /api/calendars/export/pdf should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/export/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'month' })
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('Stranger GET /api/events with foreign calendarId query param should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/events?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z&calendarId=${encodeURIComponent(ownerCalId)}`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger PUT /api/events/:uid with spoofed calendarId and foreign href should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/events/test-event-56`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({
        calendarId: strangerCalId,
        href: `/${ownerUserId}/personal/test-event-56.ics`,
        title: 'Spoofed Title',
        start: '2026-09-01T10:00:00Z',
        end: '2026-09-01T11:00:00Z'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger DELETE /api/events/:uid with spoofed calendarId and foreign href should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/events/test-event-56`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({
        calendarId: strangerCalId,
        href: `/${ownerUserId}/personal/test-event-56.ics`
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger POST /api/events/:uid/rsvp with spoofed calendarId and foreign href should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/events/test-event-56/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({
        calendarId: strangerCalId,
        href: `/${ownerUserId}/personal/test-event-56.ics`,
        email: 'test@example.com',
        status: 'ACCEPTED'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger PUT /api/tasks/:uid with spoofed calendarId and foreign href should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/test-task-56`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({
        calendarId: strangerCalId,
        href: `/${ownerUserId}/personal/test-task-56.ics`,
        title: 'Spoofed Task'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Stranger DELETE /api/tasks/:uid with spoofed calendarId and foreign href should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/test-task-56`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: strangerCookie },
      body: JSON.stringify({
        calendarId: strangerCalId,
        href: `/${ownerUserId}/personal/test-task-56.ics`
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Read-only shared user POST /api/events on shared calendar should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: readonlyUserCookie },
      body: JSON.stringify({
        calendarId: ownerCalId,
        title: 'Readonly Attempt',
        start: '2026-09-01T10:00:00Z',
        end: '2026-09-01T11:00:00Z'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Read-only shared user POST /api/tasks on shared calendar should return 403', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: readonlyUserCookie },
      body: JSON.stringify({
        calendarId: ownerCalId,
        title: 'Readonly Task Attempt'
      })
    });
    assert.strictEqual(res.status, 403);
  });
});
