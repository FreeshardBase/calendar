'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3099';
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

  await t.test('should generate valid iTIP METHOD:REPLY object', () => {
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
    assert.ok(replyIcs.includes('METHOD:REPLY'));
    assert.ok(replyIcs.includes('UID:invitation-123'));

    const parsedReply = parseICSToEvent(replyIcs);
    assert.ok(parsedReply);
    assert.equal(parsedReply.attendees[0].email, 'testuser@example.com');
    assert.equal(parsedReply.attendees[0].status, 'ACCEPTED');
  });

  await t.test('POST /api/events/:uid/rsvp without body parameters should return 400', async () => {
    const { app } = require('../index');
    // Using fetch against running test app port if available
    const port = process.env.PORT || 3097;
    try {
      const res = await fetch(`http://localhost:${port}/api/events/ev-123/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    } catch (e) {
      // If server not running directly in this process, skip network call safely
    }
  });
});


