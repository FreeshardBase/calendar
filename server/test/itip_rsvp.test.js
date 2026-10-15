'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3121';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToEvent,
  eventToICS,
  updateAttendeePartstat,
  buildItipReply
} = require('../caldav/parser');


test('iTIP & RSVP Suite', async (t) => {
  const { app, server } = require('../index');
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3121, resolve));
  }

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await t.test('should parse attendee list with initial PARTSTAT status', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:invitation-123',
      'SUMMARY:Project Sync',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'ORGANIZER;CN="Organizer User":mailto:organizer@example.com',
      'ATTENDEE;CN="Test User";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:testuser@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const event = parseICSToEvent(ics);
    assert.ok(event);
    assert.equal(event.uid, 'invitation-123');
    assert.equal(event.organizer.email, 'organizer@example.com');
    assert.equal(event.attendees.length, 1);
    assert.equal(event.attendees[0].email, 'testuser@example.com');
    assert.equal(event.attendees[0].status, 'NEEDS-ACTION');
    assert.equal(event.attendees[0].rsvp, true);
  });

  await t.test('should update attendee PARTSTAT status in ICS string', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:invitation-123',
      'SUMMARY:Project Sync',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'ORGANIZER;CN="Organizer User":mailto:organizer@example.com',
      'ATTENDEE;CN="Test User";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:testuser@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const updatedIcs = updateAttendeePartstat(originalIcs, 'testuser@example.com', 'ACCEPTED');
    assert.ok(updatedIcs);

    const updatedEvent = parseICSToEvent(updatedIcs);
    assert.ok(updatedEvent);
    assert.equal(updatedEvent.attendees[0].status, 'ACCEPTED');
  });

  await t.test('should update PARTSTAT status to DECLINED or TENTATIVE', () => {
    const originalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:invitation-456',
      'SUMMARY:Team Lunch',
      'DTSTART:20260902T120000Z',
      'DTEND:20260902T130000Z',
      'ATTENDEE;CN="Test User";PARTSTAT=NEEDS-ACTION:mailto:testuser@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const declinedIcs = updateAttendeePartstat(originalIcs, 'testuser@example.com', 'DECLINED');
    const declinedEvent = parseICSToEvent(declinedIcs);
    assert.equal(declinedEvent.attendees[0].status, 'DECLINED');

    const tentativeIcs = updateAttendeePartstat(originalIcs, 'testuser@example.com', 'TENTATIVE');
    const tentativeEvent = parseICSToEvent(tentativeIcs);
    assert.equal(tentativeEvent.attendees[0].status, 'TENTATIVE');
  });

  await t.test('should generate valid iTIP METHOD:REPLY object — raw ICS text assertions (issue #98)', () => {
    const event = {
      uid: 'invitation-123',
      title: 'Project Sync',
      start: '2026-09-01T10:00:00.000Z',
      end: '2026-09-01T11:00:00.000Z',
      organizer: { name: 'Organizer User', email: 'organizer@example.com' },
      attendees: [
        { name: 'Test User', email: 'testuser@example.com', status: 'NEEDS-ACTION' }
      ]
    };

    const replyIcs = buildItipReply(event, 'testuser@example.com', 'ACCEPTED');

    // Unfold per RFC 5545 §3.1 — CRLF followed by a single whitespace char is a fold
    const unfolded = replyIcs.replace(/\r?\n[ \t]/g, '');

    // Raw-text assertions on unfolded content catch bugs that survive ical.js re-parsing
    assert.ok(unfolded.includes('METHOD:REPLY'), 'ICS must contain METHOD:REPLY');
    assert.ok(unfolded.includes('UID:invitation-123'), 'ICS must contain correct UID');
    // Critical: PARTSTAT must appear in the serialized ICS — not just after re-parsing
    assert.ok(unfolded.includes('PARTSTAT=ACCEPTED'), 'ATTENDEE line must contain PARTSTAT=ACCEPTED');
    // Attendee email must appear as a complete mailto: URI (after unfolding)
    assert.ok(unfolded.includes('mailto:testuser@example.com'), 'ICS must contain attendee mailto: URI (unfolded)');
    // ORGANIZER must be present
    assert.ok(unfolded.includes('mailto:organizer@example.com'), 'ICS must contain organizer mailto: URI (unfolded)');
    // DECLINED must NOT appear (we asked for ACCEPTED)
    assert.ok(!unfolded.includes('PARTSTAT=DECLINED'), 'ICS must not contain PARTSTAT=DECLINED');

    // Re-parsed round-trip (secondary check)
    const parsedReply = parseICSToEvent(replyIcs);
    assert.ok(parsedReply);
    assert.equal(parsedReply.attendees[0].email, 'testuser@example.com');
    assert.equal(parsedReply.attendees[0].status, 'ACCEPTED');
  });

  await t.test('buildItipReply DECLINED — raw ICS must contain PARTSTAT=DECLINED (issue #98)', () => {
    const event = {
      uid: 'invitation-456',
      title: 'Team Lunch',
      start: '2026-09-02T12:00:00.000Z',
      end: '2026-09-02T13:00:00.000Z',
      organizer: { name: 'Boss', email: 'boss@example.com' },
      attendees: [
        { name: 'Test User', email: 'testuser@example.com', status: 'NEEDS-ACTION' }
      ]
    };

    const replyIcs = buildItipReply(event, 'testuser@example.com', 'DECLINED');
    assert.ok(replyIcs.includes('PARTSTAT=DECLINED'), 'Raw ICS must contain PARTSTAT=DECLINED');
    assert.ok(!replyIcs.includes('PARTSTAT=ACCEPTED'), 'Raw ICS must not contain PARTSTAT=ACCEPTED when declining');
  });

  await t.test('POST /api/events/:uid/rsvp without body parameters must return 400 or 401 — no silent catch (issue #98)', async () => {
    // Port is set at top of file; server was required above so it IS running.
    const port = process.env.PORT || 3099;
    const cookie = await require('./helpers/testSession').loginAs('testuser-id');
    const res = await fetch(`http://localhost:${port}/api/events/ev-123/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    // Must observe an error response — 400 (missing email) or 401 (unauthenticated).
    // Either is acceptable; what is NOT acceptable is a 2xx that certifies nothing.
    assert.ok(
      res.status === 400 || res.status === 401,
      `Expected 400 or 401 from RSVP without attendee email, got ${res.status}`
    );
    const data = await res.json();
    assert.ok(data.error, 'Response must include an error field');
  });
});


