'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const ICAL = require('ical.js');
const { eventToICS, escIcal, escParamVal } = require('../utils/ical');
const { buildItipReply } = require('../caldav/parser');

describe('Issue #314 — iCalendar Property Escaping & ATTENDEE Injection Guard', () => {
  it('should export escParamVal and escIcal helper functions', () => {
    assert.strictEqual(typeof escIcal, 'function');
    assert.strictEqual(typeof escParamVal, 'function');
  });

  it('escParamVal should strip double quotes and newlines to prevent parameter breakout', () => {
    const input = 'Attacker "Boss"\r\nATTENDEE:mailto:forged@example.com';
    const escaped = escParamVal(input);
    assert.strictEqual(escaped.includes('"'), false);
    assert.strictEqual(escaped.includes('\r'), false);
    assert.strictEqual(escaped.includes('\n'), false);
  });

  it('eventToICS should escape status, preventing iCalendar injection', () => {
    const event = {
      title: 'Normal Meeting',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      status: 'CONFIRMED\r\nATTENDEE;CUTYPE=INDIVIDUAL:mailto:forged@example.com'
    };
    const ics = eventToICS(event);
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    const attendees = vevent.getAllProperties('attendee');

    assert.strictEqual(attendees.length, 0, 'Injected ATTENDEE in status should not create an ATTENDEE property');
  });

  it('eventToICS should escape attendee name with double quotes and newlines', () => {
    const event = {
      title: 'Strategy Session',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      attendees: [
        {
          name: 'Evil "User"\r\nATTENDEE:mailto:forged@example.com',
          email: 'victim@example.com',
          status: 'ACCEPTED'
        }
      ]
    };
    const ics = eventToICS(event);
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    const attendees = vevent.getAllProperties('attendee');

    assert.strictEqual(attendees.length, 1, 'Should only have 1 attendee');
    const val = attendees[0].getFirstValue();
    assert.strictEqual(val, 'mailto:victim@example.com');
  });

  it('eventToICS should escape organizer name and email against injection', () => {
    const event = {
      title: 'All Hands',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      organizer: {
        name: 'CEO "Injected"\r\nATTENDEE:mailto:forged@example.com',
        email: 'ceo@example.com\r\nATTENDEE:mailto:forged2@example.com'
      }
    };
    const ics = eventToICS(event);
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    const attendees = vevent.getAllProperties('attendee');

    assert.strictEqual(attendees.length, 0, 'Injected ATTENDEE in organizer should not create an ATTENDEE property');
  });

  it('eventToICS should escape RRULE against newline injection', () => {
    const event = {
      title: 'Weekly Sync',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      recurrence: 'FREQ=WEEKLY\r\nATTENDEE:mailto:forged@example.com'
    };
    const ics = eventToICS(event);
    assert.strictEqual(ics.includes('\r\nATTENDEE:mailto:forged@example.com'), false, 'ICS must not contain injected ATTENDEE line');
    let comp;
    try {
      const jcal = ICAL.parse(ics);
      comp = new ICAL.Component(jcal);
    } catch (err) {
      // The forged line was folded into the RRULE value, which ical.js then rejects as a frequency.
      assert.match(err.message, /invalid frequency/);
    }
    if (comp) {
      const vevent = comp.getFirstSubcomponent('vevent');
      const attendees = vevent.getAllProperties('attendee');
      assert.strictEqual(attendees.length, 0, 'Injected ATTENDEE in RRULE should not create an ATTENDEE property');
    }
  });

  it('buildItipReply should escape organizer and attendee parameters', () => {
    const event = {
      uid: 'test-event-123',
      title: 'Meeting Reply',
      start: '2026-09-01T10:00:00Z',
      end: '2026-09-01T11:00:00Z',
      organizer: {
        name: 'Boss "Injected"\r\nATTENDEE:mailto:forged@example.com',
        email: 'boss@example.com'
      },
      attendees: [
        {
          name: 'Employee "Injected"',
          email: 'employee@example.com'
        }
      ]
    };
    const ics = buildItipReply(event, 'employee@example.com', 'ACCEPTED');
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    const attendees = vevent.getAllProperties('attendee');

    assert.strictEqual(attendees.length, 1);
    assert.strictEqual(attendees[0].getFirstValue(), 'mailto:employee@example.com');
  });
});
