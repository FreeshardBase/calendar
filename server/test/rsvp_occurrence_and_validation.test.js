'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3122';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToEvent,
  updateAttendeePartstat,
  buildItipReply
} = require('../caldav/parser');

test('Issue #67 — RSVP Attendee Validation & Occurrence Scoping', async (t) => {

  await t.test('updateAttendeePartstat does NOT invent attendee if email is not on event', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:event-1',
      'SUMMARY:Meeting',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'ATTENDEE;CN="Alice";PARTSTAT=NEEDS-ACTION:mailto:alice@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = updateAttendeePartstat(ics, 'attacker@example.com', 'ACCEPTED');
    assert.equal(result, ics, 'ICS should remain unchanged when attendee email does not exist on event');
    
    const parsed = parseICSToEvent(result);
    assert.equal(parsed.attendees.length, 1);
    assert.equal(parsed.attendees[0].email, 'alice@example.com');
  });

  await t.test('updateAttendeePartstat without recurrenceId updates master VEVENT only', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:event-2',
      'SUMMARY:Recurring Standup',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'RRULE:FREQ=DAILY',
      'ATTENDEE;CN="Bob";PARTSTAT=NEEDS-ACTION:mailto:bob@example.com',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:event-2',
      'RECURRENCE-ID:20260902T100000Z',
      'SUMMARY:Moved Standup',
      'DTSTART:20260902T120000Z',
      'DTEND:20260902T130000Z',
      'ATTENDEE;CN="Bob";PARTSTAT=TENTATIVE:mailto:bob@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = updateAttendeePartstat(ics, 'bob@example.com', 'ACCEPTED');
    
    // Master event should be ACCEPTED
    const masterEvent = parseICSToEvent(result);
    assert.equal(masterEvent.attendees[0].status, 'ACCEPTED');

    // Detached override should retain its TENTATIVE status
    const overrideEvent = parseICSToEvent(result, { recurrenceId: '20260902T100000Z' });
    assert.equal(overrideEvent.attendees[0].status, 'TENTATIVE', 'Detached override status must not be overwritten by master RSVP');
  });

  await t.test('updateAttendeePartstat with recurrenceId updates existing detached override only', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:event-3',
      'SUMMARY:Recurring Sync',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'RRULE:FREQ=DAILY',
      'ATTENDEE;CN="Charlie";PARTSTAT=NEEDS-ACTION:mailto:charlie@example.com',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:event-3',
      'RECURRENCE-ID:20260902T100000Z',
      'SUMMARY:Sync Slot',
      'DTSTART:20260902T100000Z',
      'DTEND:20260902T110000Z',
      'ATTENDEE;CN="Charlie";PARTSTAT=NEEDS-ACTION:mailto:charlie@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = updateAttendeePartstat(ics, 'charlie@example.com', 'DECLINED', '20260902T100000Z');

    // Master should still be NEEDS-ACTION
    const masterEvent = parseICSToEvent(result);
    assert.equal(masterEvent.attendees[0].status, 'NEEDS-ACTION');

    // Specified occurrence override should be DECLINED
    const overrideEvent = parseICSToEvent(result, { recurrenceId: '20260902T100000Z' });
    assert.equal(overrideEvent.attendees[0].status, 'DECLINED');
  });

  await t.test('updateAttendeePartstat with recurrenceId creates detached override if none exists', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:event-4',
      'SUMMARY:Weekly Meeting',
      'DTSTART:20260901T100000Z',
      'DTEND:20260901T110000Z',
      'RRULE:FREQ=WEEKLY',
      'ATTENDEE;CN="Dave";PARTSTAT=NEEDS-ACTION:mailto:dave@example.com',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = updateAttendeePartstat(ics, 'dave@example.com', 'DECLINED', '20260908T100000Z');

    // Master should still be NEEDS-ACTION
    const masterEvent = parseICSToEvent(result);
    assert.equal(masterEvent.attendees[0].status, 'NEEDS-ACTION');

    // Detached override should exist and be DECLINED
    const overrideEvent = parseICSToEvent(result, { recurrenceId: '20260908T100000Z' });
    assert.ok(overrideEvent, 'Must create detached override for specified occurrence');
    assert.equal(overrideEvent.attendees[0].status, 'DECLINED');
  });

  await t.test('buildItipReply includes RECURRENCE-ID when recurrenceId is provided', () => {
    const event = {
      uid: 'event-5',
      title: 'Sync',
      start: '2026-09-08T10:00:00.000Z',
      end: '2026-09-08T11:00:00.000Z',
      recurrenceId: '20260908T100000Z',
      organizer: { name: 'Org', email: 'org@example.com' },
      attendees: [{ name: 'Dave', email: 'dave@example.com', status: 'DECLINED' }]
    };

    const reply = buildItipReply(event, 'dave@example.com', 'DECLINED');
    assert.ok(reply.includes('RECURRENCE-ID:20260908T100000Z'), 'iTIP REPLY must contain RECURRENCE-ID');
  });
});
