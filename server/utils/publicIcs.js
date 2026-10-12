'use strict';

/**
 * publicIcs — Issue #341
 *
 * Reduces a calendar collection to what a public (unauthenticated) ICS share
 * may publish. Each share has a detail level:
 *
 *   - 'busy' (default): every event keeps only its time slot and recurrence;
 *     the title becomes "Belegt". Tasks and journals are dropped.
 *   - 'full': public events keep their details.
 *
 * Regardless of level, ATTENDEE/ORGANIZER (email addresses) and VALARMs are
 * removed, and CLASS:PRIVATE/CONFIDENTIAL events are reduced to busy blocks.
 * Unparseable input throws — an unfiltered calendar is never returned.
 */

const ICAL = require('ical.js');

const DETAIL_LEVELS = ['busy', 'full'];
const DEFAULT_DETAIL = 'busy';
const BUSY_SUMMARY = 'Belegt';

const BUSY_PROPS = new Set([
  'uid', 'dtstamp', 'dtstart', 'dtend', 'duration',
  'rrule', 'rdate', 'exdate', 'recurrence-id',
  'transp', 'status', 'sequence'
]);
const ITEM_COMPONENTS = new Set(['vevent', 'vtodo', 'vjournal']);

function isValidDetail(detail) {
  return DETAIL_LEVELS.includes(detail);
}

function reduceToBusy(comp) {
  for (const prop of comp.getAllProperties().slice()) {
    if (!BUSY_PROPS.has(prop.name)) comp.removeProperty(prop);
  }
  comp.removeAllSubcomponents();
  comp.addPropertyWithValue('summary', BUSY_SUMMARY);
}

function sanitizePublicIcs(ics, detail) {
  if (!isValidDetail(detail)) {
    throw new Error(`Unknown public share detail level: ${detail}`);
  }
  const vcalendar = new ICAL.Component(ICAL.parse(ics));
  if (vcalendar.name !== 'vcalendar') {
    throw new Error('Public share export is not a VCALENDAR');
  }

  for (const comp of vcalendar.getAllSubcomponents().slice()) {
    if (!ITEM_COMPONENTS.has(comp.name)) continue;

    const cls = String(comp.getFirstPropertyValue('class') || '').toUpperCase();
    const isPrivate = cls === 'PRIVATE' || cls === 'CONFIDENTIAL';

    if (comp.name !== 'vevent' && (detail === 'busy' || isPrivate)) {
      vcalendar.removeSubcomponent(comp);
      continue;
    }
    if (detail === 'busy' || isPrivate) {
      reduceToBusy(comp);
      continue;
    }
    comp.removeAllProperties('attendee');
    comp.removeAllProperties('organizer');
    comp.removeAllSubcomponents('valarm');
  }

  return vcalendar.toString() + '\r\n';
}

module.exports = { sanitizePublicIcs, isValidDetail, DETAIL_LEVELS, DEFAULT_DETAIL };
