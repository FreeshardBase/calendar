'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { buildItipReply, parseICSToEvent } = require('../caldav/parser');

function unfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

describe('Issue #127 — buildItipReply CN Escaping and Fallback Attributes', () => {
  it('buildItipReply should RFC 6868 escape CN when organizer or attendee name contains double quotes or carets', () => {
    const event = {
      uid: 'itip-issue127-1',
      title: 'Design Review',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      organizer: {
        name: 'Leader "Boss" ^1',
        email: 'leader@example.com'
      },
      attendees: [
        {
          name: 'Member "Engineer" ^2',
          email: 'member@example.com'
        }
      ]
    };

    const replyIcs = buildItipReply(event, 'member@example.com', 'ACCEPTED');
    const unfolded = unfold(replyIcs);
    assert.ok(unfolded.includes('METHOD:REPLY'));
    assert.ok(unfolded.includes('ORGANIZER;CN="Leader ^\'Boss^\' ^^1":mailto:leader@example.com'));
    assert.ok(unfolded.includes('ATTENDEE;CUTYPE=INDIVIDUAL;CN="Member ^\'Engineer^\' ^^2";PARTSTAT=ACCEPTED:mailto:member@example.com'));

    const parsed = parseICSToEvent(replyIcs);
    assert.strictEqual(parsed.organizer.name, 'Leader "Boss" ^1');
    assert.strictEqual(parsed.attendees[0].name, 'Member "Engineer" ^2');
  });

  it('buildItipReply should resolve CN from cn, displayName, attendeeName, or 4th argument fallback', () => {
    const event1 = {
      uid: 'itip-issue127-2',
      organizer: { displayName: 'Organizer Display', email: 'org@example.com' },
      attendees: [{ cn: 'Attendee CN', email: 'att1@example.com' }]
    };
    const reply1 = unfold(buildItipReply(event1, 'att1@example.com', 'ACCEPTED'));
    assert.ok(reply1.includes('ORGANIZER;CN="Organizer Display":mailto:org@example.com'));
    assert.ok(reply1.includes('ATTENDEE;CUTYPE=INDIVIDUAL;CN="Attendee CN";PARTSTAT=ACCEPTED:mailto:att1@example.com'));

    const event2 = {
      uid: 'itip-issue127-3',
      attendeeName: 'Global Attendee'
    };
    const reply2 = unfold(buildItipReply(event2, 'att2@example.com', 'DECLINED'));
    assert.ok(reply2.includes('ATTENDEE;CUTYPE=INDIVIDUAL;CN="Global Attendee";PARTSTAT=DECLINED:mailto:att2@example.com'));

    const reply3 = unfold(buildItipReply(event2, 'att3@example.com', 'TENTATIVE', 'Explicit Arg Name'));
    assert.ok(reply3.includes('ATTENDEE;CUTYPE=INDIVIDUAL;CN="Explicit Arg Name";PARTSTAT=TENTATIVE:mailto:att3@example.com'));
  });

  it('buildItipReply should strip newlines from CN to prevent iCalendar header injection', () => {
    const event = {
      uid: 'itip-issue127-4',
      organizer: { name: 'Admin\r\nORGANIZER:mailto:evil@example.com', email: 'admin@example.com' },
      attendees: [{ name: 'User\nATTENDEE:mailto:evil@example.com', email: 'user@example.com' }]
    };

    const replyIcs = buildItipReply(event, 'user@example.com', 'ACCEPTED');
    // Ensure raw newlines inside parameters were stripped so no injected header lines are created
    assert.strictEqual(replyIcs.includes('\nORGANIZER:mailto:evil@example.com'), false);
    assert.strictEqual(replyIcs.includes('\nATTENDEE:mailto:evil@example.com'), false);
  });
});
