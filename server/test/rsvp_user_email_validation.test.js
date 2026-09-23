'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3110';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const eventsRouter = require('../routes/events');

test('Issue #77 — RSVP User Email Validation & Hardcoded Placeholder Removal', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));

  // Helper middleware for mocking sessions
  app.use((req, res, next) => {
    if (req.headers['x-test-user-id']) {
      req.session.userId = req.headers['x-test-user-id'];
      req.session.username = req.headers['x-test-username'] || req.headers['x-test-user-id'];
      req.session.accounts = [
        {
          id: 'internal-caldav',
          url: 'http://localhost:3110/mock-dav',
          username: req.headers['x-test-username'] || req.headers['x-test-user-id']
        }
      ];
    }
    next();
  });

  app.get(['/mock-dav/*', '/user-alice-77/*'], (req, res) => {
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').send(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:test-event-1
SUMMARY:Test Event
DTSTART:20260710T100000Z
DTEND:20260710T110000Z
END:VEVENT
END:VCALENDAR`);
  });

  app.use('/api/events', eventsRouter);

  let server;
  const baseUrl = 'http://localhost:3110';

  t.before(async () => {
    await Db.upsertUser('user-alice-77', 'alice@example.com');
    await Db.upsertUser('user-bob-77', 'bob@example.com');
    server = app.listen(3110);
  });

  t.after(() => {
    if (server) server.close();
  });

  await t.test('Frontend invitations.js must not contain hardcoded placeholder email', () => {
    const invitationsJsPath = path.join(__dirname, '../../public/js/invitations.js');
    const content = fs.readFileSync(invitationsJsPath, 'utf8');
    assert.ok(
      !content.includes("const email = 'testuser@example.com';"),
      'invitations.js should not hardcode testuser@example.com'
    );
  });

  await t.test('POST /api/events/:uid/rsvp with unauthorized email address should return 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-alice-77/personal/',
        href: '/user-alice-77/personal/event-77-test.ics',
        email: 'attacker@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 403, 'Should reject RSVP for email not belonging to authenticated session');
    const data = await res.json();
    assert.ok(data.error, 'Should contain error description');
    assert.ok(data.error.includes('Unauthorized email address for RSVP'), 'Should be an email validation failure, not a calendar access failure');
  });

  await t.test('GET /api/events/invitations annotates userEmail based on user session identity', async () => {
    const res = await fetch(`${baseUrl}/api/events/invitations`, {
      headers: {
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice@example.com'
      }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });
});
