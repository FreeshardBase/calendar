'use strict';

/**
 * server/utils/ical.js — iCalendar (RFC 5545) & VALARM parsing utilities.
 */

const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');

/**
 * Parse an iCalendar TRIGGER string into millisecond offset.
 * Handles ISO 8601 duration values like -PT15M, -P1D, -PT1H, -P1W, PT0S, etc.
 */
function parseTriggerOffsetMs(trigger) {
  if (!trigger) return -15 * 60 * 1000;
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return 0;

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return -15 * 60 * 1000;

  const sign = match[1] === '-' ? -1 : 1;
  const weeks = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  const hours = parseInt(match[4] || '0', 10);
  const mins = parseInt(match[5] || '0', 10);
  const secs = parseInt(match[6] || '0', 10);

  const totalMs = ((((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
  return sign * totalMs;
}

/**
 * Compute target alarm Date for an event start date and trigger.
 */
function calculateAlarmTime(startIso, trigger) {
  if (!startIso) return null;
  const startMs = new Date(startIso).getTime();
  if (isNaN(startMs)) return null;
  const offsetMs = parseTriggerOffsetMs(trigger);
  return new Date(startMs + offsetMs);
}

/**
 * Extract all VALARM blocks from a VEVENT ICAL component.
 */
function parseValarms(vevent) {
  const alarms = [];
  if (!vevent || typeof vevent.getAllSubcomponents !== 'function') return alarms;

  for (const valarm of vevent.getAllSubcomponents('valarm')) {
    const action = (valarm.getFirstPropertyValue('action') || 'DISPLAY').toString().toUpperCase();
    const trigProp = valarm.getFirstProperty('trigger');
    let trigger = null;
    if (trigProp) {
      const val = trigProp.getFirstValue();
      trigger = typeof val === 'object' && val !== null ? val.toString() : String(val);
    }
    const description = valarm.getFirstPropertyValue('description') || null;
    alarms.push({
      action,
      trigger: trigger || '-PT15M',
      description
    });
  }
  return alarms;
}

function parseVEventToEvent(vevent, meta = {}) {
  const ev = new ICAL.Event(vevent);

  const dtstart  = ev.startDate;
  const dtend    = ev.endDate;
  const isAllDay = dtstart && dtstart.isDate;

  // Attendees
  const attendees = [];
  for (const prop of vevent.getAllProperties('attendee')) {
    const val   = prop.getFirstValue();
    const email = (typeof val === 'string' ? val : '').replace(/^mailto:/i, '');
    attendees.push({
      name:   prop.getParameter('cn')      || '',
      email,
      status: prop.getParameter('partstat') || 'NEEDS-ACTION',
      rsvp:   prop.getParameter('rsvp')    === 'TRUE'
    });
  }

  // Organizer
  let organizer = null;
  const orgProp = vevent.getFirstProperty('organizer');
  if (orgProp) {
    const val = orgProp.getFirstValue();
    organizer = {
      name:  orgProp.getParameter('cn') || '',
      email: (typeof val === 'string' ? val : '').replace(/^mailto:/i, '')
    };
  }

  // Recurrence rule
  let recurrence = null;
  const rrule = vevent.getFirstProperty('rrule');
  if (rrule) recurrence = rrule.getFirstValue().toString();

  // Timezones
  let startTimeZone = null;
  const startProp = vevent.getFirstProperty('dtstart');
  if (startProp) {
    startTimeZone = startProp.getParameter('tzid') || null;
  }

  let endTimeZone = null;
  const endProp = vevent.getFirstProperty('dtend');
  if (endProp) {
    endTimeZone = endProp.getParameter('tzid') || null;
  }

  // Alarms (VALARM)
  const alarms = parseValarms(vevent);

  return {
    uid:         ev.uid,
    title:       ev.summary   || '(No title)',
    start:       dtstart      ? dtstart.toJSDate().toISOString() : null,
    end:         dtend        ? dtend.toJSDate().toISOString()   : null,
    allDay:      isAllDay,
    location:    ev.location  || null,
    description: ev.description || null,
    status:      vevent.getFirstPropertyValue('status') || null,
    attendees,
    organizer,
    recurrence,
    startTimeZone,
    endTimeZone,
    alarms,
    calendarId:  meta.calendarId  || null,
    accountId:   meta.accountId   || null,
    href:        meta.href        || null,
    etag:        meta.etag        || null
  };
}

function parseICSToEvent(icsString, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp  = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;
  return parseVEventToEvent(vevent, meta);
}

function parseAndExpandEvent(icsString, rangeStart, rangeEnd, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) return [];

  const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
  const event = parseVEventToEvent(master, meta);
  if (!event) return [];

  if (!master.getFirstProperty('rrule')) {
    return [event];
  }

  if (!rangeStart || !rangeEnd) {
    return [event];
  }

  const icalEvent = new ICAL.Event(master);
  for (const v of vevents) {
    if (v !== master && v.getFirstProperty('recurrence-id')) {
      icalEvent.relateException(new ICAL.Event(v));
    }
  }

  const limitStart = new Date(rangeStart);
  const limitEnd = new Date(rangeEnd);

  const iterator = icalEvent.iterator();
  const instances = [];
  let next;
  let count = 0;
  const maxCount = 500;

  while ((next = iterator.next()) && count < maxCount) {
    count++;
    let details;
    try {
      details = icalEvent.getOccurrenceDetails(next);
    } catch (e) {
      continue;
    }
    const occStart = details.startDate.toJSDate();
    const occEnd = details.endDate.toJSDate();

    if (next.toJSDate().getTime() > limitEnd.getTime()) {
      break;
    }

    if (occEnd.getTime() >= limitStart.getTime() && occStart.getTime() <= limitEnd.getTime()) {
      const recurrenceId = details.recurrenceId.toString();
      const isOverride = details.item.component !== master;
      const base = isOverride ? parseVEventToEvent(details.item.component, meta) : event;
      instances.push({
        ...base,
        uid: `${event.uid}::${recurrenceId}`,
        masterUid: event.uid,
        start: occStart.toISOString(),
        end: occEnd.toISOString(),
        recurrenceId,
        recurrence: event.recurrence,
        alarms: base.alarms || event.alarms || []
      });
    }
  }

  return instances;
}

function eventToICS(event) {
  const uid      = event.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp  = fmtDateTime(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `LAST-MODIFIED:${dtstamp}`,
    `SUMMARY:${escIcal(event.title || 'Untitled')}`
  ];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtDate(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtDate(event.end)}`);
  } else {
    if (event.startTimeZone) {
      lines.push(`DTSTART;TZID=${event.startTimeZone}:${fmtDateTimeTzid(event.start, event.startTimeZone)}`);
    } else {
      lines.push(`DTSTART:${fmtDateTime(event.start)}`);
    }

    if (event.endTimeZone) {
      lines.push(`DTEND;TZID=${event.endTimeZone}:${fmtDateTimeTzid(event.end, event.endTimeZone)}`);
    } else {
      lines.push(`DTEND:${fmtDateTime(event.end)}`);
    }
  }

  if (event.description) lines.push(`DESCRIPTION:${escIcal(event.description)}`);
  if (event.location)    lines.push(`LOCATION:${escIcal(event.location)}`);
  if (event.status)      lines.push(`STATUS:${event.status}`);

  if (event.organizer?.email) {
    const cn = event.organizer.name ? `;CN="${event.organizer.name}"` : '';
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }

  for (const att of (event.attendees || [])) {
    if (!att.email) continue;
    const cn      = att.name   ? `;CN="${att.name}"`           : '';
    const partstat = `;PARTSTAT=${att.status || 'NEEDS-ACTION'}`;
    lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL${cn}${partstat};RSVP=TRUE:mailto:${att.email}`);
  }

  if (event.recurrence) lines.push(`RRULE:${event.recurrence}`);

  const alarms = Array.isArray(event.alarms) ? event.alarms : (event.valarm ? [event.valarm] : []);
  for (const alarm of alarms) {
    lines.push('BEGIN:VALARM');
    lines.push(`ACTION:${alarm.action || 'DISPLAY'}`);
    lines.push(`TRIGGER:${alarm.trigger || '-PT15M'}`);
    if (alarm.description) {
      lines.push(`DESCRIPTION:${escIcal(alarm.description)}`);
    }
    lines.push('END:VALARM');
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return foldLines(lines.join('\n')) + '\r\n';
}

function getMasterVEvent(comp) {
  const vevents = comp.getAllSubcomponents('vevent');
  const master = vevents.find(v => !v.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('NO_MASTER_EVENT');
  return master;
}

function occurrenceTime(master, recurrenceId) {
  const time = ICAL.Time.fromString(recurrenceId);
  const dtstart = master.getFirstPropertyValue('dtstart');
  if (dtstart && !time.isDate) time.zone = dtstart.zone;
  return time;
}

function removeOverride(comp, recurrenceId) {
  for (const v of comp.getAllSubcomponents('vevent')) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (rid && rid.toString() === recurrenceId) {
      comp.removeSubcomponent(v);
    }
  }
}

function addOccurrenceException(icsString, recurrenceId) {
  const comp = new ICAL.Component(ICAL.parse(icsString));
  const master = getMasterVEvent(comp);

  removeOverride(comp, recurrenceId);

  const time = occurrenceTime(master, recurrenceId);
  const prop = new ICAL.Property('exdate', master);
  const dtstartProp = master.getFirstProperty('dtstart');
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  if (tzid) prop.setParameter('tzid', tzid);
  prop.setValue(time);
  master.addProperty(prop);

  return comp.toString();
}

function upsertOccurrenceOverride(icsString, recurrenceId, eventData) {
  const comp = new ICAL.Component(ICAL.parse(icsString));
  const master = getMasterVEvent(comp);
  const masterUid = master.getFirstPropertyValue('uid');

  removeOverride(comp, recurrenceId);

  const overrideIcs = eventToICS({ ...eventData, uid: masterUid, recurrence: null });
  const override = new ICAL.Component(ICAL.parse(overrideIcs)).getFirstSubcomponent('vevent');

  const rid = new ICAL.Property('recurrence-id', override);
  const dtstartProp = master.getFirstProperty('dtstart');
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  if (tzid) rid.setParameter('tzid', tzid);
  rid.setValue(occurrenceTime(master, recurrenceId));
  override.addProperty(rid);

  comp.addSubcomponent(override);
  return comp.toString();
}

function escIcal(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function fmtDateTime(iso) {
  return new Date(iso).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function fmtDateTimeTzid(iso, tzid) {
  const date = new Date(iso);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const partMap = {};
  for (const p of parts) partMap[p.type] = p.value;

  let hour = partMap.hour;
  if (hour === '24') hour = '00';
  return `${partMap.year}${partMap.month}${partMap.day}T${hour}${partMap.minute}${partMap.second}`;
}

function fmtDate(iso) {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
}

function foldLines(text) {
  return text.split('\n').map(line => {
    line = line.replace(/\r$/, '');
    if (line.length <= 75) return line;
    const parts = [line.slice(0, 75)];
    let i = 75;
    while (i < line.length) {
      parts.push(' ' + line.slice(i, i + 74));
      i += 74;
    }
    return parts.join('\r\n');
  }).join('\r\n');
}

module.exports = {
  parseTriggerOffsetMs,
  calculateAlarmTime,
  parseValarms,
  parseVEventToEvent,
  parseICSToEvent,
  parseAndExpandEvent,
  eventToICS,
  addOccurrenceException,
  upsertOccurrenceOverride
};
