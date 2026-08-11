'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3096';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT || 3097}`;

test.describe('VTODO / Tasks API Routes Integration Suite', () => {

  test.after(() => {
    if (server && server.close) server.close();
  });

  test('GET /api/tasks should return tasks list', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { 'x-test-user-id': 'test-tasks-user' }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  test('POST /api/tasks without calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'test-tasks-user'
      },
      body: JSON.stringify({ title: 'Invalid Task' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('PUT /api/tasks/:uid without href or calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-123`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'test-tasks-user'
      },
      body: JSON.stringify({ title: 'Updated Task' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('DELETE /api/tasks/:uid without href or calendarId should return 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/task-123`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'test-tasks-user'
      },
      body: JSON.stringify({})
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

});
