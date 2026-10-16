'use strict';

// Issue #216: the write path must keep clock time, DESCRIPTION/LOCATION and text escaping intact.
// The browser-level half lives in e2e/calendar.spec.js (clock-time spec with a second save, and the
// invitations spec with markup in every rendered field).

const test = require('node:test');
const assert = require('node:assert');
const { eventToICS, parseICSToEvent } = require('../utils/ical');

function unfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

test('Issue #216 — eventToICS/parseICSToEvent keep clock time, DESCRIPTION, LOCATION and special characters', () => {
  const event = {
    uid: 'test-216-uid-123',
    title: 'Sprint Review & Retrospective: "Q3"; C:\\new, ok',
    location: 'Room #101 (Bldg B; Floor 2, Zone 3)',
    description: 'Notes:\n- Feature A; test\n- Feature B, ok',
    start: '2028-10-15T09:30:00.000Z',
    end: '2028-10-15T10:30:00.000Z',
    allDay: false
  };

  const ics = unfold(eventToICS(event));
  assert.ok(ics.includes('SUMMARY:Sprint Review & Retrospective: "Q3"\\; C:\\\\new\\, ok'), ics);
  assert.ok(ics.includes('LOCATION:Room #101 (Bldg B\\; Floor 2\\, Zone 3)'), ics);
  assert.ok(ics.includes('DESCRIPTION:Notes:\\n- Feature A\\; test\\n- Feature B\\, ok'), ics);
  assert.ok(ics.includes('DTSTART:20281015T093000Z'), ics);

  const parsed = parseICSToEvent(ics);
  assert.strictEqual(parsed.title, event.title);
  assert.strictEqual(parsed.location, event.location);
  assert.strictEqual(parsed.description, event.description);
  assert.strictEqual(parsed.start, event.start);
  assert.strictEqual(parsed.end, event.end);
});

test('Issue #216 — a line break in a title cannot inject a property into the stored ICS', () => {
  const title = 'Harmless\nATTENDEE:mailto:testuser@example.com';
  const ics = unfold(eventToICS({
    uid: 'test-216-inject',
    title,
    start: '2028-10-15T09:30:00.000Z',
    end: '2028-10-15T10:30:00.000Z',
    allDay: false
  }));

  assert.ok(!/\r?\nATTENDEE/.test(ics), ics);
  const parsed = parseICSToEvent(ics);
  assert.strictEqual(parsed.title, title);
  assert.deepStrictEqual(parsed.attendees, []);
});

test('Issue #216 — a quote, semicolon and colon in a CN survive the round trip', () => {
  const name = 'Test "User"; Team: A';
  const ics = unfold(eventToICS({
    uid: 'test-216-cn',
    title: 'CN quoting',
    start: '2028-10-15T09:30:00.000Z',
    end: '2028-10-15T10:30:00.000Z',
    allDay: false,
    organizer: { name, email: 'testuser@example.com' },
    attendees: [{ name, email: 'testuser@example.com', status: 'NEEDS-ACTION' }]
  }));

  const parsed = parseICSToEvent(ics);
  assert.strictEqual(parsed.organizer.name, name);
  assert.strictEqual(parsed.organizer.email, 'testuser@example.com');
  assert.strictEqual(parsed.attendees.length, 1);
  assert.strictEqual(parsed.attendees[0].name, name);
  assert.strictEqual(parsed.attendees[0].email, 'testuser@example.com');
});
