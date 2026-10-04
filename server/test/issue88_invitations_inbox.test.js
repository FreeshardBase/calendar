'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const eventsRouter = require('../routes/events');
const http = require('http');

test('Issue #88 — Invitations inbox excludes TENTATIVE and ORGANIZER', async (t) => {
  const events = {
    'ev1.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev1
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'ev2.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev2
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:bob@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'ev3.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev3
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'standup.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:daily-standup-uid
DTSTART:20260901T090000Z
DTEND:20260901T093000Z
RRULE:FREQ=DAILY;COUNT=92
SUMMARY:Daily Standup
ORGANIZER:mailto:lead@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'accepted.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-accepted
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'declined.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-declined
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`,
    'non_attendee.ics': `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-non-attendee
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:charlie@example.com
END:VEVENT
END:VCALENDAR`
  };

  const caldavServer = http.createServer((req, res) => {
    const filename = req.url.split('/').pop().split('?')[0];

    if (req.method === 'GET' && events[filename]) {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'ETag': '"etag-1"' });
      res.end(events[filename]);
      return;
    }

    if (req.method === 'PUT' && events[filename]) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        events[filename] = body;
        res.writeHead(204, { 'ETag': '"etag-updated"' });
        res.end();
      });
      return;
    }

    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="utf-8" ?>
        <d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <d:response>
            <d:href>/cal/1/</d:href>
            <d:propstat>
              <d:prop>
                <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
                <d:displayname>Test</d:displayname>
                <cal:calendar-timezone>BEGIN:VTIMEZONE\nTZID:UTC\nEND:VTIMEZONE</cal:calendar-timezone>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`);
    } else if (req.method === 'REPORT') {
      const responses = Object.entries(events).map(([file, ics]) => `
          <d:response>
            <d:href>/cal/1/${file}</d:href>
            <d:propstat>
              <d:prop>
                <cal:calendar-data>${ics}</cal:calendar-data>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>`).join('');

      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="utf-8" ?>
        <d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          ${responses}
        </d:multistatus>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => caldavServer.listen(0, resolve));
  const caldavPort = caldavServer.address().port;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'bob-123',
      userEmail: 'bob@example.com',
      accounts: [{ id: 'test-acc', url: `http://127.0.0.1:${caldavPort}/cal/1/`, authType: 'basic', username: 'bob', password: 'password' }]
    };
    next();
  });
  app.use('/api/events', eventsRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  t.after(() => {
    server.close();
    caldavServer.close();
  });

  const res = await fetch(`http://localhost:${port}/api/events/invitations`);
  const data = await res.json();
  
  assert.equal(data.length, 2, 'Only ev3 and single daily-standup card should remain (not 92 cards, no accepted/declined/tentative/organizer/non-attendee)');
  const standupCards = data.filter(inv => inv.uid === 'daily-standup-uid');
  assert.equal(standupCards.length, 1, 'Recurring daily standup must collapse to exactly 1 card with base UID');
  assert.ok(data.some(inv => inv.uid === 'ev3'), 'ev3 should be included');

  // Verify non-attendee, accepted, declined, tentative, and organized are NOT included
  assert.ok(!data.some(inv => inv.uid === 'ev1'), 'ev1 (TENTATIVE) must be excluded');
  assert.ok(!data.some(inv => inv.uid === 'ev2'), 'ev2 (ORGANIZER) must be excluded');
  assert.ok(!data.some(inv => inv.uid === 'ev-accepted'), 'ev-accepted must be excluded');
  assert.ok(!data.some(inv => inv.uid === 'ev-declined'), 'ev-declined must be excluded');
  assert.ok(!data.some(inv => inv.uid === 'ev-non-attendee'), 'ev-non-attendee must be excluded');

  // RSVP TENTATIVE to the recurring daily standup
  const standupCard = standupCards[0];
  const rsvpRes = await fetch(`http://localhost:${port}/api/events/${standupCard.uid}/rsvp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: standupCard.calendarId,
      href: standupCard.href,
      email: 'bob@example.com',
      status: 'TENTATIVE'
    })
  });
  assert.equal(rsvpRes.status, 200);
  const rsvpData = await rsvpRes.json();
  assert.equal(rsvpData.status, 'TENTATIVE');

  // Verify that answering TENTATIVE immediately clears it from invitations list
  const resAfter = await fetch(`http://localhost:${port}/api/events/invitations`);
  const dataAfter = await resAfter.json();
  assert.equal(dataAfter.length, 1, 'Standup card must disappear upon RSVP TENTATIVE, leaving only ev3');
  assert.equal(dataAfter[0].uid, 'ev3');
});
