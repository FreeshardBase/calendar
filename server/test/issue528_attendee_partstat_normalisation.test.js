'use strict';

// Issue #528: ATTENDEE;PARTSTAT arrives verbatim from remote calendars and reached the
// event dialog's markup. The parser must only ever hand out an RFC 5545 participation status.

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseICSToEvent } = require('../utils/ical');

function icsWithAttendees(attendeeLines) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Issue528//EN',
    'BEGIN:VEVENT',
    'UID:issue528@example.com',
    'DTSTAMP:20360301T000000Z',
    'DTSTART:20360326T090000Z',
    'DTEND:20360326T100000Z',
    'SUMMARY:Issue 528',
    ...attendeeLines,
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
}

function statuses(attendeeLines) {
  return parseICSToEvent(icsWithAttendees(attendeeLines)).attendees.map(a => a.status);
}

describe('Issue #528 — attendee PARTSTAT is normalised to the RFC 5545 set when parsing', () => {
  it('maps a markup-carrying PARTSTAT to NEEDS-ACTION', () => {
    const result = statuses([
      'ATTENDEE;CN=Test User;PARTSTAT="><b id=inj>x</b><span class=":mailto:testuser@example.com'
    ]);
    assert.deepStrictEqual(result, ['NEEDS-ACTION']);
  });

  it('treats unknown x-name and iana-token values as NEEDS-ACTION', () => {
    const result = statuses([
      'ATTENDEE;PARTSTAT=X-MAYBE:mailto:testuser@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED foo:mailto:testuser2@example.com',
      'ATTENDEE;PARTSTAT=COMPLETED:mailto:testuser3@example.com',
      'ATTENDEE:mailto:testuser4@example.com'
    ]);
    assert.deepStrictEqual(result, ['NEEDS-ACTION', 'NEEDS-ACTION', 'NEEDS-ACTION', 'NEEDS-ACTION']);
  });

  it('keeps every VEVENT participation status and upper-cases it', () => {
    const result = statuses([
      'ATTENDEE;PARTSTAT=accepted:mailto:testuser@example.com',
      'ATTENDEE;PARTSTAT=DECLINED:mailto:testuser2@example.com',
      'ATTENDEE;PARTSTAT=Tentative:mailto:testuser3@example.com',
      'ATTENDEE;PARTSTAT=DELEGATED:mailto:testuser4@example.com',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:testuser5@example.com'
    ]);
    assert.deepStrictEqual(result, ['ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED', 'NEEDS-ACTION']);
  });
});
