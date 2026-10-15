'use strict';
process.env.NODE_ENV = 'test';
process.env.DISABLE_INTERNAL_CALDAV = '1';

// Issue #67, section 3 and the follow-up review: a per-occurrence RSVP must
// synthesize an override whose DTEND follows its own DTSTART, and the iTIP
// REPLY must echo the request's SEQUENCE (RFC 5546) for the answered instance.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const {
  parseICSToEvent,
  updateAttendeePartstat,
  buildItipReply
} = require('../caldav/parser');

function series(lines) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:issue67-series',
    'SUMMARY:Weekly Meeting',
    ...lines,
    'RRULE:FREQ=WEEKLY',
    'ORGANIZER;CN=Test Organizer:mailto:organizer@example.com',
    'ATTENDEE;CN=Test User;PARTSTAT=NEEDS-ACTION:mailto:testuser@example.com',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function overrideOf(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const overrides = comp.getAllSubcomponents('vevent').filter(v => v.getFirstProperty('recurrence-id'));
  assert.equal(overrides.length, 1, 'exactly one detached override must be created');
  return overrides[0];
}

test('per-occurrence RSVP override keeps the occurrence duration (UTC series)', () => {
  const ics = series(['DTSTART:20260901T100000Z', 'DTEND:20260901T110000Z', 'SEQUENCE:3']);
  const result = updateAttendeePartstat(ics, 'testuser@example.com', 'DECLINED', '20260908T100000Z');

  const ev = parseICSToEvent(result, { recurrenceId: '20260908T100000Z' });
  assert.equal(ev.start, '2026-09-08T10:00:00.000Z');
  assert.equal(ev.end, '2026-09-08T11:00:00.000Z');
  assert.equal(ev.attendees[0].status, 'DECLINED');

  const override = overrideOf(result);
  assert.equal(override.getFirstPropertyValue('dtend').toString(), '2026-09-08T11:00:00Z');
});

test('per-occurrence RSVP override keeps the wall-clock duration across a DST change (TZID series)', () => {
  const ics = series([
    'DTSTART;TZID=Europe/Berlin:20261020T100000',
    'DTEND;TZID=Europe/Berlin:20261020T113000'
  ]);
  // 27 Oct is after the switch to CET: 10:00 Berlin = 09:00Z.
  const result = updateAttendeePartstat(ics, 'testuser@example.com', 'ACCEPTED', '20261027T090000Z');

  const ev = parseICSToEvent(result, { recurrenceId: '20261027T090000Z' });
  assert.ok(ev, 'override must be found by its occurrence');
  assert.equal(ev.start, '2026-10-27T09:00:00.000Z');
  assert.equal(ev.end, '2026-10-27T10:30:00.000Z');
  assert.equal(ev.attendees[0].status, 'ACCEPTED');
});

test('per-occurrence RSVP override on an all-day series ends the day after its own start', () => {
  const ics = series(['DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260902']);
  const result = updateAttendeePartstat(ics, 'testuser@example.com', 'TENTATIVE', '20260908');

  const override = overrideOf(result);
  assert.equal(override.getFirstPropertyValue('dtstart').toString(), '2026-09-08');
  assert.equal(override.getFirstPropertyValue('dtend').toString(), '2026-09-09');
  assert.equal(override.getFirstPropertyValue('recurrence-id').toString(), '2026-09-08');
});

test('iTIP REPLY echoes the SEQUENCE of the answered request', () => {
  const ics = series(['DTSTART:20260901T100000Z', 'DTEND:20260901T110000Z', 'SEQUENCE:3']);
  const updated = updateAttendeePartstat(ics, 'testuser@example.com', 'DECLINED', '20260908T100000Z');

  // Same path as POST /api/events/:uid/rsvp
  const parsed = parseICSToEvent(updated, { recurrenceId: '20260908T100000Z' });
  const reply = buildItipReply({ ...parsed, recurrenceId: '20260908T100000Z' }, 'testuser@example.com', 'DECLINED');
  const vevent = new ICAL.Component(ICAL.parse(reply)).getFirstSubcomponent('vevent');

  assert.equal(vevent.getFirstPropertyValue('sequence'), 3);
  assert.equal(vevent.getFirstPropertyValue('recurrence-id').toString(), '2026-09-08T10:00:00Z');
  assert.equal(vevent.getFirstPropertyValue('dtend').toString(), '2026-09-08T11:00:00Z');
});

test('iTIP REPLY uses the override SEQUENCE when the occurrence was revised on its own', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:issue67-series',
    'SUMMARY:Weekly Meeting',
    'DTSTART:20260901T100000Z',
    'DTEND:20260901T110000Z',
    'SEQUENCE:1',
    'RRULE:FREQ=WEEKLY',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:testuser@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:issue67-series',
    'SUMMARY:Weekly Meeting (moved)',
    'RECURRENCE-ID:20260908T100000Z',
    'DTSTART:20260908T140000Z',
    'DTEND:20260908T150000Z',
    'SEQUENCE:5',
    'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:testuser@example.com',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const parsed = parseICSToEvent(ics, { recurrenceId: '20260908T100000Z' });
  const reply = buildItipReply({ ...parsed, recurrenceId: '20260908T100000Z' }, 'testuser@example.com', 'ACCEPTED');
  const vevent = new ICAL.Component(ICAL.parse(reply)).getFirstSubcomponent('vevent');
  assert.equal(vevent.getFirstPropertyValue('sequence'), 5);
});

test('iTIP REPLY carries SEQUENCE:0 when the request has none (RFC 5545 default)', () => {
  const ics = series(['DTSTART:20260901T100000Z', 'DTEND:20260901T110000Z']);
  const parsed = parseICSToEvent(ics);
  const reply = buildItipReply(parsed, 'testuser@example.com', 'ACCEPTED');
  const vevent = new ICAL.Component(ICAL.parse(reply)).getFirstSubcomponent('vevent');
  assert.equal(vevent.getFirstPropertyValue('sequence'), 0);
});
