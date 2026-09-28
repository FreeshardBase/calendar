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
      if (req.headers['x-test-email']) {
        req.session.userEmail = req.headers['x-test-email'];
      } else if (req.headers['x-test-username'] && req.headers['x-test-username'].includes('@')) {
        req.session.userEmail = req.headers['x-test-username'];
      }
      req.session.accounts = [
        {
          id: 'internal-caldav',
          url: 'http://localhost:3110/mock-dav',
          username: req.headers['x-test-username'] || req.headers['x-test-user-id']
        }
      ];
      if (req.headers['x-mock-account-username']) {
        req.session.accounts.push({
          id: 'external-caldav',
          url: 'http://localhost:3110/mock-external-dav',
          username: req.headers['x-mock-account-username']
        });
      }
    }
    next();
  });

  const eventIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:event-77-test
SUMMARY:Test Event 77
DTSTART:20260710T100000Z
DTEND:20260710T110000Z
ORGANIZER;CN=Boss:mailto:boss@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Alice:mailto:alice@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Bob:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`;

  let lastPutBody = null;

  app.get('/mock-dav/*', (req, res) => {
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', '"etag-77-v1"').send(eventIcs);
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', '"etag-77-v1"').send(eventIcs);
  });

  app.put('*', express.text({ type: '*/*' }), (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    lastPutBody = req.body;
    res.status(200).set('ETag', '"etag-77-v2"').send();
  });

  app.use('/api/events', eventsRouter);

  let server;
  const baseUrl = 'http://localhost:3110';

  t.before(async () => {
    await Db.upsertUser('user-alice-77', 'alice', 'alice@example.com');
    await Db.upsertUser('user-bob-77', 'bob', 'bob@example.com');
    await Db.upsertUser('user-stranger-77', 'stranger', 'stranger@example.com');
    await Db.upsertUser('user-noemail-77', 'noemailuser');
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
    assert.ok(
      content.includes('data-email='),
      'invitations.js must pass data-email attribute on RSVP buttons'
    );
  });

  await t.test('POST /api/events/:uid/rsvp with unauthorized email address should return 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice',
        'x-test-email': 'alice@example.com'
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
    assert.ok(data.error.includes('Unauthorized email address for RSVP'), 'Should be an email validation failure');
  });

  await t.test('POST /api/events/:uid/rsvp: Attacker asserting victim email via external CalDAV account is rejected with 403', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-bob-77',
        'x-test-username': 'bob',
        'x-test-email': 'bob@example.com',
        'x-mock-account-username': 'alice@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-bob-77/personal/',
        href: '/user-bob-77/personal/event-77-test.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 403, 'Should reject RSVP when user attempts to assert Alice email');
    const data = await res.json();
    assert.ok(data.error.includes('Unauthorized email address for RSVP'), 'Should be an unauthorized email address error');
  });

  await t.test('POST /api/events/:uid/rsvp: Session with no verified email cannot RSVP (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-noemail-77'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-noemail-77/personal/',
        href: '/user-noemail-77/personal/event-77-test.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 403, 'Session with no verified email must be rejected with 403');
    const data = await res.json();
    assert.ok(data.error.includes('No verified user email') || data.error.includes('Unauthorized email'), 'Must fail email check');
  });

  await t.test('POST /api/events/:uid/rsvp: User can RSVP with own verified email (returns 200 OK)', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice',
        'x-test-email': 'alice@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-alice-77/personal/',
        href: '/user-alice-77/personal/event-77-test.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 200, `Expected 200 for own-email RSVP, got ${res.status}`);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'ACCEPTED');
    assert.ok(data.itipReply, 'Must return itipReply');
    assert.ok(data.itipReply.includes('PARTSTAT=ACCEPTED'), 'itipReply must contain PARTSTAT=ACCEPTED');

    const unfoldedPut = (lastPutBody || '').replace(/\r?\n[ \t]/g, '');
    assert.ok(unfoldedPut.includes('mailto:alice@example.com'), 'Put ICS must contain alice');
    assert.ok(unfoldedPut.includes('PARTSTAT=ACCEPTED'), 'Put ICS must update PARTSTAT to ACCEPTED');
  });

  await t.test('POST /api/events/:uid/rsvp: User can RSVP without email; server auto-selects verified session attendee (returns 200 OK)', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice',
        'x-test-email': 'alice@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-alice-77/personal/',
        href: '/user-alice-77/personal/event-77-test.ics',
        status: 'DECLINED'
      })
    });

    assert.equal(res.status, 200, `Expected 200 for auto-detected attendee RSVP, got ${res.status}`);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'DECLINED');
    assert.ok(data.itipReply.includes('PARTSTAT=DECLINED'), 'itipReply must contain PARTSTAT=DECLINED');
  });

  await t.test('POST /api/events/:uid/rsvp: User not listed as attendee on event receives 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-stranger-77',
        'x-test-username': 'stranger',
        'x-test-email': 'stranger@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-stranger-77/personal/',
        href: '/user-stranger-77/personal/event-77-test.ics',
        email: 'stranger@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 400, 'Non-attendee should receive 400 Bad Request');
    const data = await res.json();
    assert.ok(data.error.includes('Attendee email not found on event'), 'Should indicate attendee not found');
  });

  await t.test('POST /api/events/:uid/rsvp: Calendar ACL denial returns 403 distinct from email validation', async () => {
    const res = await fetch(`${baseUrl}/api/events/event-77-test/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'user-stranger-77',
        'x-test-username': 'stranger',
        'x-test-email': 'stranger@example.com'
      },
      body: JSON.stringify({
        calendarId: 'internal-caldav::/user-alice-77/personal/',
        href: '/user-alice-77/personal/event-77-test.ics',
        email: 'alice@example.com',
        status: 'ACCEPTED'
      })
    });

    assert.equal(res.status, 403, 'Calendar ACL failure should return 403');
    const data = await res.json();
    assert.ok(data.error.includes('Access denied: You do not have permission for this calendar'), 'Must be calendar ACL error');
  });

  await t.test('GET /api/events/invitations annotates userEmail based on user session identity', async () => {
    const res = await fetch(`${baseUrl}/api/events/invitations`, {
      headers: {
        'x-test-user-id': 'user-alice-77',
        'x-test-username': 'alice',
        'x-test-email': 'alice@example.com'
      }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    if (data.length > 0) {
      assert.equal(data[0].userEmail, 'alice@example.com', 'Invitation userEmail must match session email');
    }
  });
});
