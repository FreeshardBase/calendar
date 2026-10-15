'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3177';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const eventsRouter = require('../routes/events');
const authRouter = require('../routes/auth');

test('Issue #77 — Deep Server User Email Validation & RSVP ACL Verification', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret-77', resave: false, saveUninitialized: true }));

  // Test-local mock session middleware on this standalone app (not the
  // production server, which ignores identity headers since #245/#50).
  app.use(async (req, res, next) => {
    if (req.headers['x-mock-user-id']) {
      req.session.userId = req.headers['x-mock-user-id'];
      req.session.username = req.headers['x-mock-username'] || req.headers['x-mock-user-id'];
      if (req.headers['x-mock-email']) {
        req.session.userEmail = req.headers['x-mock-email'];
      }
      req.session.accounts = [
        {
          id: 'internal-caldav',
          url: 'http://localhost:3177/mock-dav',
          username: req.headers['x-mock-username'] || req.headers['x-mock-user-id']
        }
      ];
      if (req.headers['x-mock-account-username']) {
        req.session.accounts.push({
          id: 'account-attacker-controlled',
          url: 'http://localhost:3177/mock-attacker-dav',
          username: req.headers['x-mock-account-username']
        });
      }
    }
    next();
  });

  // Mock CalDAV server storage
  let sharedCalendarIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:shared-meeting-77
SUMMARY:Project Sync
DTSTART:20260710T100000Z
DTEND:20260710T110000Z
ORGANIZER;CN=Boss:mailto:boss@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Alice:mailto:alice@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Bob:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`;

  let lastPutBody = null;

  app.get('/mock-dav/*', (req, res) => {
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', '"etag-77-v1"').send(sharedCalendarIcs);
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', '"etag-77-v1"').send(sharedCalendarIcs);
  });

  app.put('*', express.text({ type: '*/*' }), (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    lastPutBody = req.body;
    res.status(200).set('ETag', '"etag-77-v2"').send();
  });

  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);

  let server;
  const baseUrl = 'http://localhost:3177';

  t.before(async () => {
    await Db.upsertUser('user-alice-77', 'alice', 'alice@example.com');
    await Db.upsertUser('user-bob-77', 'bob', 'bob@example.com');
    await Db.upsertUser('user-no-email-77', 'noemailuser');
    server = app.listen(3177);
  });

  t.after(() => {
    if (server) server.close();
  });

  // Finding 1: Database stores and retrieves user email
  await t.test('1. Db stores and retrieves user email via getUserEmailByUserId', async () => {
    assert.equal(typeof Db.getUserEmailByUserId, 'function', 'Db.getUserEmailByUserId must be a function');
    const aliceEmail = await Db.getUserEmailByUserId('user-alice-77');
    assert.equal(aliceEmail, 'alice@example.com', 'Should return alice email stored via upsertUser');
  });

  // Finding 2: Session route returns email
  await t.test('2. GET /api/auth/session returns user email', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        'x-mock-user-id': 'user-alice-77',
        'x-mock-username': 'alice',
        'x-mock-email': 'alice@example.com'
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.email, 'alice@example.com', 'Session response must include verified email');
  });

  // Finding 3: Attacker cannot assert another user email via external CalDAV account
  await t.test('3. Attacker with linked account username alice@example.com cannot RSVP as alice@example.com', async () => {
    const res = await fetch(`${baseUrl}/api/events/shared-meeting-77/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-user-id': 'user-bob-77',
        'x-mock-username': 'bob',
        'x-mock-email': 'bob@example.com',
        'x-mock-account-username': 'alice@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-bob-77/personal/',
        href: '/user-bob-77/personal/shared-meeting-77.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });
    assert.equal(res.status, 403, 'Should reject RSVP when user attempts to RSVP with Alice email');
    const data = await res.json();
    assert.ok(data.error.includes('Unauthorized email address for RSVP'), 'Must be unauthorized email address error');
  });

  // Finding 4: Session without verified email is rejected from RSVP (no bypass when validEmails is empty)
  await t.test('4. Session without verified email is rejected with 403', async () => {
    const res = await fetch(`${baseUrl}/api/events/shared-meeting-77/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-user-id': 'user-no-email-77'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-no-email-77/personal/',
        href: '/user-no-email-77/personal/shared-meeting-77.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });
    assert.equal(res.status, 403, 'Should reject RSVP when session has no verified email');
    const data = await res.json();
    assert.ok(data.error.includes('No verified user email') || data.error.includes('Unauthorized email'), 'Must fail email validation');
  });

  // Finding 5: User can RSVP with own email and successfully update PARTSTAT
  await t.test('5. User Bob can RSVP with his own verified email bob@example.com', async () => {
    const res = await fetch(`${baseUrl}/api/events/shared-meeting-77/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-user-id': 'user-bob-77',
        'x-mock-username': 'bob',
        'x-mock-email': 'bob@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-bob-77/personal/',
        href: '/user-bob-77/personal/shared-meeting-77.ics',
        email: 'bob@example.com',
        status: 'ACCEPTED'
      })
    });
    assert.equal(res.status, 200, `Expected 200 for valid own-email RSVP, got ${res.status}`);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'ACCEPTED');
    assert.ok(data.itipReply, 'Must return itipReply');
    assert.ok(data.itipReply.includes('PARTSTAT=ACCEPTED'), 'itipReply must contain PARTSTAT=ACCEPTED');
    const unfoldedPut = (lastPutBody || '').replace(/\r?\n[ \t]/g, '');
    assert.ok(unfoldedPut.includes('mailto:bob@example.com'), 'Put ICS must contain bob');
    assert.ok(unfoldedPut.includes('PARTSTAT=ACCEPTED'), 'Put ICS must contain PARTSTAT=ACCEPTED');
  });

  // Finding 6: User can RSVP without email in request body; server auto-detects attendee matching verified email
  await t.test('6. User Bob can RSVP without specifying email in request body', async () => {
    const res = await fetch(`${baseUrl}/api/events/shared-meeting-77/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mock-user-id': 'user-bob-77',
        'x-mock-username': 'bob',
        'x-mock-email': 'bob@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-bob-77/personal/',
        href: '/user-bob-77/personal/shared-meeting-77.ics',
        status: 'DECLINED'
      })
    });
    assert.equal(res.status, 200, `Expected 200 for auto-detected email RSVP, got ${res.status}`);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'DECLINED');
    assert.ok(data.itipReply.includes('PARTSTAT=DECLINED'), 'itipReply must contain PARTSTAT=DECLINED');
  });
});
