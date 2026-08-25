'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const ICAL = require('ical.js');
const { eventToICS, parseICSToEvent, escParamVal } = require('../utils/ical');
const { buildItipReply } = require('../caldav/parser');

describe('Issue #63 — Attendee Name Double Quote Preservation in Quoted ICS Parameters', () => {
  it('escParamVal should escape double quotes using RFC 6868 (^i) without stripping them', () => {
    const input = 'Jane "The Boss" Doe';
    const escaped = escParamVal(input);
    assert.strictEqual(escaped, "Jane ^'The Boss^' Doe");
    assert.strictEqual(escaped.includes('"'), false, 'Should not contain raw unescaped double quotes');
  });

  it('eventToICS and parseICSToEvent should round-trip attendee and organizer names with double quotes', () => {
    const event = {
      title: 'Board Meeting',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      organizer: {
        name: 'Manager "Lead" Smith',
        email: 'manager@example.com'
      },
      attendees: [
        {
          name: 'Jane "The Boss" Doe',
          email: 'jane@example.com',
          status: 'ACCEPTED'
        }
      ]
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('VCALENDAR'), 'Should generate valid ICS string');

    const parsed = parseICSToEvent(ics);
    assert.strictEqual(parsed.organizer.name, 'Manager "Lead" Smith');
    assert.strictEqual(parsed.attendees.length, 1);
    assert.strictEqual(parsed.attendees[0].name, 'Jane "The Boss" Doe');
  });

  it('eventToICS with existingIcs should preserve double quotes across edits', () => {
    const initialEvent = {
      title: 'Initial Meeting',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      attendees: [
        {
          name: 'Jane "The Boss" Doe',
          email: 'jane@example.com',
          status: 'ACCEPTED'
        }
      ]
    };
    const initialIcs = eventToICS(initialEvent);

    const updatedEvent = {
      title: 'Updated Meeting Title',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      attendees: [
        {
          name: 'Jane "The Boss" Doe',
          email: 'jane@example.com',
          status: 'ACCEPTED'
        }
      ]
    };

    const updatedIcs = eventToICS(updatedEvent, initialIcs);
    const parsed = parseICSToEvent(updatedIcs);
    assert.strictEqual(parsed.title, 'Updated Meeting Title');
    assert.strictEqual(parsed.attendees[0].name, 'Jane "The Boss" Doe');
  });

  it('buildItipReply should generate valid iTIP reply when attendee name contains double quotes', () => {
    const event = {
      uid: 'test-itip-quote-123',
      title: 'Project Review',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      organizer: {
        name: 'Boss "Big" Man',
        email: 'boss@example.com'
      },
      attendees: [
        {
          name: 'Dev "Pro" User',
          email: 'dev@example.com'
        }
      ]
    };

    const ics = buildItipReply(event, 'dev@example.com', 'ACCEPTED');
    assert.ok(ics.includes('METHOD:REPLY'));

    const parsed = parseICSToEvent(ics);
    assert.strictEqual(parsed.attendees[0].name, 'Dev "Pro" User');
  });
});
