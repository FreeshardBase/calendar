'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const { checkCalendarAccess } = require('../utils/calendarAuth');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

test('Issue #155 — Prevent path-traversal authorization bypass on POST /api/calendars/:id/shares', async (t) => {
  let server;
  let baseUrl;

  t.before(async () => {
    // Register users in DB for tests
    await Db.upsertUser('attacker_user_155', 'attacker_user_155', 'attacker_155@example.com');
    await Db.upsertUser('victim_user_155', 'victim_user_155', 'victim_155@example.com');
    await Db.upsertUser('owner_user_155', 'owner_user_155', 'owner_155@example.com');
    await Db.upsertUser('sharee_user_155', 'sharee_user_155', 'sharee_155@example.com');

    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret-155',
      resave: false,
      saveUninitialized: true
    }));

    // Test auth middleware helper
    app.use((req, res, next) => {
      const authUser = req.headers['x-test-user'];
      if (authUser) {
        req.session.userId = authUser;
      }
      next();
    });

    app.use('/api/calendars', calendarsRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('checkCalendarAccess correctly resolves owner under path traversal attempts', async () => {
    const reqAttacker = { session: { userId: 'attacker_user_155' } };
    const traversalCalId = 'internal-caldav::/attacker_user_155/../victim_user_155/personal/';

    const access = await checkCalendarAccess(reqAttacker, traversalCalId, 'owner');
    assert.equal(access.allowed, false, 'Attacker must not be granted owner access via path traversal');
    assert.equal(access.status, 403);
  });

  await t.test('POST /api/calendars/:id/shares returns 403 when attacker attempts path traversal to self-grant access', async () => {
    const traversalCalId = encodeURIComponent('internal-caldav::/attacker_user_155/../victim_user_155/personal/');
    const res = await fetch(`${baseUrl}/api/calendars/${traversalCalId}/shares`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'attacker_user_155'
      },
      body: JSON.stringify({
        sharee: 'attacker_user_155',
        readWrite: true
      })
    });

    assert.equal(res.status, 403, 'Should reject path-traversal share creation with 403 Forbidden');
    const data = await res.json();
    assert.ok(data.error, 'Error field should be present in response');
  });

  await t.test('POST /api/calendars/:id/shares allows legitimate owner to add share', async () => {
    const ownerCalId = encodeURIComponent('internal-caldav::/owner_user_155/personal/');
    const res = await fetch(`${baseUrl}/api/calendars/${ownerCalId}/shares`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'owner_user_155'
      },
      body: JSON.stringify({
        sharee: 'sharee_user_155',
        readWrite: true
      })
    });

    assert.equal(res.status, 200, 'Legitimate owner should be able to send share invite');
    const data = await res.json();
    assert.equal(data.sharee, 'sharee_user_155');
  });
});
