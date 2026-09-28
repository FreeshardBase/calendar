'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const eventsRouter = require('../routes/events');
const http = require('http');

test('Issue #88 — Invitations inbox excludes TENTATIVE and ORGANIZER', async (t) => {
  const caldavServer = http.createServer((req, res) => {
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
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="utf-8" ?>
        <d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <d:response>
            <d:href>/cal/1/ev1.ics</d:href>
            <d:propstat>
              <d:prop>
                <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev1
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.com
END:VEVENT
END:VCALENDAR</cal:calendar-data>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/cal/1/ev2.ics</d:href>
            <d:propstat>
              <d:prop>
                <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev2
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:bob@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR</cal:calendar-data>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/cal/1/ev3.ics</d:href>
            <d:propstat>
              <d:prop>
                <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev3
DTSTART:20260923T100000Z
DTEND:20260923T110000Z
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR</cal:calendar-data>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => caldavServer.listen(0, resolve));
  const caldavPort = caldavServer.address().port;

  const app = express();
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
  
  assert.equal(data.length, 1, 'Only one invitation should remain');
  assert.equal(data[0].uid, 'ev3', 'ev3 should be included');
});
