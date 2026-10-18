'use strict';

// Issue #506: the event dialog edits availability (TRANSP) and visibility
// (CLASS). Both round-trip through the ICS on create, on edit of a stored
// event, and on an occurrence override; unknown values are refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseICSToEvent, eventToICS, isNoOpEventSave, updateWholeSeries, upsertOccurrenceOverride
} = require('../utils/ical');

const BASE = {
  uid: 'issue506@example.com',
  title: 'Test Event',
  start: '2036-03-02T09:00:00Z',
  end: '2036-03-02T10:00:00Z'
};

test('a new event stores TRANSP and CLASS and reads them back', () => {
  const ics = eventToICS({ ...BASE, transp: 'TRANSPARENT', classification: 'PRIVATE' });
  assert.match(ics, /^TRANSP:TRANSPARENT\r?$/m);
  assert.match(ics, /^CLASS:PRIVATE\r?$/m);
  const ev = parseICSToEvent(ics);
  assert.equal(ev.transp, 'TRANSPARENT');
  assert.equal(ev.classification, 'PRIVATE');
});

test('editing a stored event changes and clears TRANSP and CLASS', () => {
  const stored = eventToICS({ ...BASE, transp: 'TRANSPARENT', classification: 'CONFIDENTIAL' });
  const changed = eventToICS({ ...BASE, transp: 'OPAQUE', classification: 'PUBLIC' }, stored);
  const ev = parseICSToEvent(changed);
  assert.equal(ev.transp, 'OPAQUE');
  assert.equal(ev.classification, 'PUBLIC');

  const cleared = parseICSToEvent(eventToICS({ ...BASE, transp: null, classification: null }, stored));
  assert.equal(cleared.transp, null);
  assert.equal(cleared.classification, null);

  // Fields not sent at all stay as they are.
  const untouched = parseICSToEvent(eventToICS({ ...BASE }, stored));
  assert.equal(untouched.transp, 'TRANSPARENT');
  assert.equal(untouched.classification, 'CONFIDENTIAL');
});

test('a whole-series edit and an occurrence override carry TRANSP and CLASS', () => {
  const series = eventToICS({ ...BASE, recurrence: 'FREQ=DAILY;COUNT=3' });
  const updated = parseICSToEvent(updateWholeSeries(series, {
    ...BASE, recurrence: 'FREQ=DAILY;COUNT=3', transp: 'TRANSPARENT', classification: 'PRIVATE'
  }));
  assert.equal(updated.transp, 'TRANSPARENT');
  assert.equal(updated.classification, 'PRIVATE');

  const withOverride = upsertOccurrenceOverride(series, '20360303T090000Z', {
    ...BASE, start: '2036-03-03T09:00:00Z', end: '2036-03-03T10:00:00Z', classification: 'PRIVATE'
  });
  const occ = parseICSToEvent(withOverride, { recurrenceId: '20360303T090000Z' });
  assert.equal(occ.classification, 'PRIVATE');
});

test('changing only TRANSP or CLASS is not swallowed as a no-op save', () => {
  const stored = eventToICS({ ...BASE });
  assert.equal(isNoOpEventSave(stored, { ...BASE }), true);
  assert.equal(isNoOpEventSave(stored, { ...BASE, transp: 'OPAQUE', classification: 'PUBLIC' }), true,
    'the RFC 5545 defaults equal an absent property');
  assert.equal(isNoOpEventSave(stored, { ...BASE, transp: 'TRANSPARENT' }), false);
  assert.equal(isNoOpEventSave(stored, { ...BASE, classification: 'PRIVATE' }), false);
});

test('unknown TRANSP or CLASS values are refused', () => {
  assert.throws(() => eventToICS({ ...BASE, transp: 'MAYBE' }), /transp/i);
  assert.throws(() => eventToICS({ ...BASE, classification: 'SECRET\r\nX-EVIL:1' }), /class/i);
});
