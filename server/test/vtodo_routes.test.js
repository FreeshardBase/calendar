'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3096';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
process.env.CALDAVURL = process.env.CALDAVURL || `http://localhost:${process.env.PORT}/mock-dav/`;
process.env.CALDAV_USERNAME = process.env.CALDAV_USERNAME || 'test';
process.env.CALDAV_PASSWORD = process.env.CALDAV_PASSWORD || 'test';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;
const testUserId = 'test-vtodo-routes-user';
const authHeaders = {
  'Content-Type': 'application/json'
};

test.describe('VTODO / Tasks API Routes Integration Suite', () => {

  test.before(async () => {
    if (server && !server.listening) {
      await new Promise((resolve, reject) => {
        server.listen(process.env.PORT, '127.0.0.1', (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
    authHeaders.cookie = await loginAs(testUserId);
  });

  test.after(() => {
    if (server && server.close) server.close();
  });

  test('GET /api/tasks without authentication should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, 'Authentication required');
  });

  test('POST /api/tasks without authentication should return 401', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId: 'env-default::/mock-dav/', title: 'Unauthenticated Task' })
    });
    assert.equal(res.status, 401);
  });

  test('POST /api/tasks without calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Invalid Task' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.equal(data.error, 'calendarId is required');
  });

  test('PUT /api/tasks/:uid without href or calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-123`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Updated Task' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('DELETE /api/tasks/:uid without href or calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-123`, {
      method: 'DELETE',
      headers: authHeaders,
      body: JSON.stringify({})
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('POST, GET, PUT, and DELETE /api/tasks lifecycle with CalDAV synchronization', async () => {
    // 1. Initialize user session accounts via /api/accounts
    const accRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: authHeaders.cookie }
    });
    assert.equal(accRes.status, 200);

    const targetCalendarId = 'env-default::/mock-dav/calendars/test/personal/';

    // 2. Create task via POST /api/tasks
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        title: 'CalDAV Integration Task',
        description: 'Testing task creation end-to-end',
        status: 'NEEDS-ACTION',
        priority: 1,
        due: '2026-09-20T10:00:00.000Z'
      })
    });

    assert.equal(createRes.status, 201);
    const createdTask = await createRes.json();
    assert.ok(createdTask.uid);
    assert.equal(createdTask.title, 'CalDAV Integration Task');
    assert.equal(createdTask.status, 'NEEDS-ACTION');
    assert.equal(createdTask.priority, 1);
    assert.equal(createdTask.calendarId, targetCalendarId);
    assert.ok(createdTask.href);
    assert.ok(createdTask.etag);

    // 3. Verify task is returned in GET /api/tasks
    const getRes = await fetch(`${baseUrl}/api/tasks`, {
      headers: authHeaders
    });

    assert.equal(getRes.status, 200);
    const tasksList = await getRes.json();
    assert.ok(Array.isArray(tasksList));
    const fetchedTask = tasksList.find(t => t.uid === createdTask.uid);
    assert.ok(fetchedTask, 'Created task must be found in GET /api/tasks output');
    assert.equal(fetchedTask.title, 'CalDAV Integration Task');
    assert.equal(fetchedTask.priority, 1);

    // 4. Update task via PUT /api/tasks/:uid
    const updateRes = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: createdTask.href,
        etag: createdTask.etag,
        title: 'CalDAV Integration Task (Updated)',
        status: 'COMPLETED',
        percentComplete: 100
      })
    });

    assert.equal(updateRes.status, 200);
    const updatedTask = await updateRes.json();
    assert.equal(updatedTask.title, 'CalDAV Integration Task (Updated)');
    assert.equal(updatedTask.status, 'COMPLETED');
    assert.equal(updatedTask.percentComplete, 100);

    // Verify update was persisted in CalDAV by doing GET /api/tasks
    const getRes2 = await fetch(`${baseUrl}/api/tasks`, {
      headers: authHeaders
    });
    assert.equal(getRes2.status, 200);
    const tasksList2 = await getRes2.json();
    const fetchedTask2 = tasksList2.find(t => t.uid === createdTask.uid);
    assert.ok(fetchedTask2);
    assert.equal(fetchedTask2.title, 'CalDAV Integration Task (Updated)');

    // 5. Delete task via DELETE /api/tasks/:uid
    const deleteRes = await fetch(`${baseUrl}/api/tasks/${createdTask.uid}`, {
      method: 'DELETE',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: targetCalendarId,
        href: createdTask.href,
        etag: updatedTask.etag || createdTask.etag
      })
    });

    assert.equal(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.equal(deleteData.message, 'Task deleted.');

    // 6. Verify task is no longer returned in GET /api/tasks
    const getRes3 = await fetch(`${baseUrl}/api/tasks`, {
      headers: authHeaders
    });
    assert.equal(getRes3.status, 200);
    const tasksList3 = await getRes3.json();
    assert.ok(!tasksList3.some(t => t.uid === createdTask.uid), 'Deleted task must not appear in tasks list');
  });

  test('POST /api/tasks with unauthorized calendarId should return 403 or 404', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        calendarId: 'invalid-account-id::/forbidden-path/',
        title: 'Unauthorized Task'
      })
    });

    assert.ok(res.status === 403 || res.status === 404);
  });

});
