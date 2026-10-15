'use strict';

/**
 * server/utils/ical.js — iCalendar (RFC 5545) & VALARM parsing utilities.
 */

const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');
const { isSafeLinkUrl } = require('../../public/js/safeUrl');

/**
 * Attachment URLs end up as clickable links, so only http(s)/mailto may be
 * written to an event (issue #338).
 */
function assertSafeAttachmentUrl(url) {
  if (!isSafeLinkUrl(url)) {
    throw new Error('Unsafe attachment URL rejected: only http, https and mailto URLs are allowed');
  }
}

/**
 * Parse an iCalendar TRIGGER string into millisecond offset.
 * Handles ISO 8601 duration values like -PT15M, -P1D, -PT1H, -P1W, PT0S, etc.
 */
function parseTriggerOffsetMs(trigger, startIso) {
  if (!trigger || typeof trigger === 'object') return null;
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }
  if (str.toUpperCase().startsWith('VALUE=DATE-TIME:')) {
    str = str.substring(16).trim();
  }
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return 0;

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (match) {
    const hasComponent = match[2] || match[3] || match[4] || match[5] || match[6];
    if (hasComponent) {
      const sign = match[1] === '-' ? -1 : 1;
      const weeks = parseInt(match[2] || '0', 10);
      const days = parseInt(match[3] || '0', 10);
      const hours = parseInt(match[4] || '0', 10);
      const mins = parseInt(match[5] || '0', 10);
      const secs = parseInt(match[6] || '0', 10);

      const totalMs = ((((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
      return sign * totalMs;
    }
  }

  const absMs = new Date(str).getTime();
  if (!isNaN(absMs)) {
    if (startIso) {
      const startMs = new Date(startIso).getTime();
      if (!isNaN(startMs)) return absMs - startMs;
    }
    return absMs;
  }

  return null;
}

/**
 * Compute target alarm Date for an event start date and trigger.
 */
function calculateAlarmTime(startIso, trigger) {
  if (!startIso) return null;
  const startMs = new Date(startIso).getTime();
  if (isNaN(startMs)) return null;
  const offsetMs = parseTriggerOffsetMs(trigger, startIso);
  if (offsetMs === null || isNaN(offsetMs)) return null;
  return new Date(startMs + offsetMs);
}

/**
 * Absolute TRIGGER value as a UTC ICAL.Time. RFC 5545 requires UTC; a value
 * from a non-conformant client is read in its own TZID, else in the event's
 * DTSTART zone (UTC if that is floating too), so it can be written back legally.
 */
function absoluteTriggerToUtc(val, trigProp, vevent) {
  if (val.zone === ICAL.Timezone.utcTimezone) return val;
  if (val.zone && val.zone !== ICAL.Timezone.localTimezone) {
    return val.convertToZone(ICAL.Timezone.utcTimezone);
  }
  const dtstart = vevent.getFirstProperty('dtstart');
  const tzid = trigProp.getParameter('tzid') || (dtstart ? dtstart.getParameter('tzid') : null);
  const pad = (n) => String(n).padStart(2, '0');
  const utc = getUtcDate(`${val.year}-${pad(val.month)}-${pad(val.day)}`, `${pad(val.hour)}:${pad(val.minute)}`, tzid);
  utc.setUTCSeconds(val.second);
  return ICAL.Time.fromJSDate(utc, true);
}

/**
 * One VALARM component as { action, trigger, description[, related] }.
 */
function valarmToAlarm(valarm, vevent) {
  const action = (valarm.getFirstPropertyValue('action') || 'DISPLAY').toString().toUpperCase();
  const trigProp = valarm.getFirstProperty('trigger');
  let trigger = null;
  let related = null;
  if (trigProp) {
    let val = trigProp.getFirstValue();
    if (trigProp.type === 'date-time' && val) val = absoluteTriggerToUtc(val, trigProp, vevent);
    trigger = typeof val === 'object' && val !== null ? val.toString() : String(val);
    // RELATED only applies to a duration trigger (RFC 5545 §3.8.6.3); START is the default.
    if (trigProp.type !== 'date-time' && String(trigProp.getParameter('related') || '').toUpperCase() === 'END') {
      related = 'END';
    }
  }
  const alarm = {
    action,
    trigger: trigger || '-PT15M',
    description: valarm.getFirstPropertyValue('description') || null
  };
  if (related) alarm.related = related;
  return alarm;
}

// Two alarms with the same identity are the same reminder; used to keep a
// stored VALARM (REPEAT, ATTACH, X- properties …) when it is saved back unchanged.
function alarmIdentity(alarm) {
  return [
    String(alarm.action || 'DISPLAY').toUpperCase(),
    String(alarm.related || 'START').toUpperCase(),
    String(alarm.trigger || '-PT15M').trim(),
    alarm.description || ''
  ].join('|');
}

/**
 * Extract all VALARM blocks from a VEVENT ICAL component.
 */
function parseValarms(vevent) {
  if (!vevent || typeof vevent.getAllSubcomponents !== 'function') return [];
  return vevent.getAllSubcomponents('valarm').map(valarm => valarmToAlarm(valarm, vevent));
}

// RFC 5545 §3.3.6 dur-value.
const TRIGGER_DURATION_RE = /^[+-]?P(?=\d|T\d)(?:\d+W|(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;
// An absolute trigger must be a UTC DATE-TIME (RFC 5545 §3.8.6.3). Accepts the
// extended form parseValarms produces and the basic iCalendar form.
const TRIGGER_ABSOLUTE_RE = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?Z$/;

/**
 * Validate one alarm and return its TRIGGER content line. Throws on anything a
 * CalDAV server would reject or misread, so a bad trigger is never written.
 */
function alarmTriggerLine(alarm) {
  if (!alarm || typeof alarm !== 'object' || Array.isArray(alarm)) {
    throw new Error('Invalid alarm: each alarm must be an object with a trigger');
  }
  const trigger = alarm.trigger === undefined || alarm.trigger === null || alarm.trigger === ''
    ? '-PT15M'
    : alarm.trigger;
  if (typeof trigger !== 'string') {
    throw new Error('Invalid alarm trigger: must be a string');
  }
  const related = alarm.related === undefined || alarm.related === null || alarm.related === ''
    ? null
    : String(alarm.related).toUpperCase();
  if (related !== null && related !== 'START' && related !== 'END') {
    throw new Error(`Invalid alarm RELATED value "${alarm.related}": must be START or END`);
  }

  if (TRIGGER_DURATION_RE.test(trigger)) {
    return related === 'END' ? `TRIGGER;RELATED=END:${trigger}` : `TRIGGER:${trigger}`;
  }

  const abs = trigger.match(TRIGGER_ABSOLUTE_RE);
  if (abs) {
    if (related !== null) {
      throw new Error('Invalid alarm: RELATED is only allowed on a duration trigger, not on an absolute DATE-TIME');
    }
    const [, y, mo, d, h, mi, s] = abs;
    const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    if (date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 60) {
      throw new Error(`Invalid alarm trigger "${trigger}": not a real date-time`);
    }
    return `TRIGGER;VALUE=DATE-TIME:${y}${mo}${d}T${h}${mi}${s}Z`;
  }

  throw new Error(`Invalid alarm trigger "${trigger}": expected an RFC 5545 duration (e.g. -PT15M) or a UTC date-time (e.g. 20260809T200000Z)`);
}

/**
 * Throw if `alarms` (when present) is not an array of valid alarms.
 */
function assertValidAlarms(alarms) {
  if (alarms === undefined || alarms === null) return;
  if (!Array.isArray(alarms)) {
    throw new Error('Invalid alarms: must be an array');
  }
  for (const alarm of alarms) alarmTriggerLine(alarm);
}

function icalTimeToISO(icalTime) {
  if (!icalTime) return null;
  if (icalTime.isDate) {
    const y = String(icalTime.year).padStart(4, '0');
    const m = String(icalTime.month).padStart(2, '0');
    const d = String(icalTime.day).padStart(2, '0');
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  return icalTime.toJSDate().toISOString();
}

function parseVEventToEvent(vevent, meta = {}) {
  if (vevent && typeof vevent.getAllProperties === 'function') {
    const datePropNames = ['dtstart', 'dtend', 'due', 'recurrence-id', 'exdate', 'rdate'];
    for (const name of datePropNames) {
      for (const prop of vevent.getAllProperties(name)) {
        const tzid = prop.getParameter('tzid');
        if (tzid && isValidTimezone(tzid) && !ICAL.TimezoneService.has(tzid)) {
          _registerVTimezoneBlock(tzid, buildVTimezoneBlock(tzid));
        }
      }
    }
  }

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
    const tzid = startProp.getParameter('tzid');
    if (tzid) {
      if (isValidTimezone(tzid)) {
        startTimeZone = tzid;
        _registerVTimezoneBlock(tzid, buildVTimezoneBlock(tzid));
      } else if (ICAL.TimezoneService.has(tzid)) {
        startTimeZone = tzid;
      } else {
        console.warn(`[timezone] Unrecognized or invalid TZID "${tzid}" in DTSTART`);
      }
    }
  }

  let endTimeZone = null;
  const endProp = vevent.getFirstProperty('dtend');
  if (endProp) {
    const tzid = endProp.getParameter('tzid');
    if (tzid) {
      if (isValidTimezone(tzid)) {
        endTimeZone = tzid;
        _registerVTimezoneBlock(tzid, buildVTimezoneBlock(tzid));
      } else if (ICAL.TimezoneService.has(tzid)) {
        endTimeZone = tzid;
      } else {
        console.warn(`[timezone] Unrecognized or invalid TZID "${tzid}" in DTEND`);
      }
    }
  } else if (startTimeZone) {
    endTimeZone = startTimeZone;
  }

  let duration = null;
  const durProp = vevent.getFirstProperty('duration');
  if (durProp) {
    const val = durProp.getFirstValue();
    duration = val ? val.toString() : null;
  }

  // Alarms (VALARM)
  const alarms = parseValarms(vevent);

  // Categories (CATEGORIES)
  const categories = [];
  for (const prop of vevent.getAllProperties('categories')) {
    const vals = prop.getValues();
    if (Array.isArray(vals)) {
      for (const val of vals) {
        if (typeof val === 'string' && val.trim()) {
          categories.push(val.trim());
        }
      }
    } else if (typeof vals === 'string' && vals.trim()) {
      vals.split(',').forEach(v => {
        if (v.trim()) categories.push(v.trim());
      });
    }
  }

  // Attachments (ATTACH)
  const attachments = [];
  for (const prop of vevent.getAllProperties('attach')) {
    const val = prop.getFirstValue();
    const url = typeof val === 'string' ? val : (val && val.toString ? val.toString() : '');
    // Foreign data (invitations, imports, webcal, sync): drop non-link schemes.
    if (!isSafeLinkUrl(url)) continue;
    let name = prop.getParameter('x-filename') || prop.getParameter('filename') || prop.getParameter('cn') || null;
    if (!name) {
      const parts = url.split('/');
      name = parts[parts.length - 1] || 'Attachment';
    }
    const mimeType = prop.getParameter('fmttype') || null;
    attachments.push({ url, name, mimeType });
  }

  return {
    uid:         ev.uid,
    title:       ev.summary   || '(No title)',
    start:       dtstart      ? icalTimeToISO(dtstart) : null,
    end:         dtend        ? icalTimeToISO(dtend)   : null,
    duration:    duration     || null,
    allDay:      isAllDay,
    location:    ev.location  || null,
    description: ev.description || null,
    status:      vevent.getFirstPropertyValue('status') || null,
    sequence:    vevent.getFirstPropertyValue('sequence') || 0,
    transp:      vevent.getFirstPropertyValue('transp') || null,
    attendees,
    organizer,
    recurrence,
    startTimeZone,
    endTimeZone,
    alarms,
    attachments,
    categories,
    calendarId:  meta.calendarId  || null,
    accountId:   meta.accountId   || null,
    href:        meta.href        || null,
    etag:        meta.etag        || null,
    rawIcs:      meta.rawIcs      || null
  };
}

function parseICSToEvent(icsString, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp  = new ICAL.Component(jcal);
  _registerEmbeddedTimezones(comp);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) return null;

  let vevent;
  const targetRid = (meta.recurrenceId || meta.recurrence_id || '').toString();
  if (targetRid) {
    const normTarget = targetRid.replace(/[-:]/g, '').toUpperCase();
    const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
    const targetTime = master ? occurrenceTime(master, targetRid) : null;
    const targetUtcMs = targetTime ? targetTime.toJSDate().getTime() : null;

    vevent = vevents.find(v => {
      const rid = v.getFirstPropertyValue('recurrence-id');
      if (!rid) return false;
      const str = rid.toICALString ? rid.toICALString() : rid.toString();
      const normStr = str.replace(/[-:]/g, '').toUpperCase();
      if (normStr === normTarget) return true;
      if (targetUtcMs !== null && typeof rid.toJSDate === 'function') {
        if (rid.toJSDate().getTime() === targetUtcMs) return true;
      }
      return false;
    });
  } else {
    vevent = vevents.find(v => !v.getFirstProperty('recurrence-id'));
  }

  if (!vevent && !targetRid) {
    vevent = vevents[0];
  }

  if (!vevent) return null;

  return parseVEventToEvent(vevent, { ...meta, rawIcs: meta.rawIcs || icsString });
}


function parseAndExpandEvent(icsString, rangeStart, rangeEnd, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  _registerEmbeddedTimezones(comp);
  return expandVEventGroup(comp.getAllSubcomponents('vevent'), rangeStart, rangeEnd, meta);
}

/**
 * Expand every series in a multi-UID VCALENDAR (e.g. a webcal feed) into the
 * occurrences overlapping [rangeStart, rangeEnd]. Non-recurring events outside
 * the window are dropped. Throws on invalid iCalendar input.
 */
function expandCalendarInRange(icsString, rangeStart, rangeEnd, meta = {}) {
  const comp = new ICAL.Component(ICAL.parse(icsString));
  _registerEmbeddedTimezones(comp);
  const groups = new Map();
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    const uid = vevent.getFirstPropertyValue('uid');
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(vevent);
  }
  const startMs = new Date(rangeStart).getTime();
  const endMs = new Date(rangeEnd).getTime();
  const result = [];
  for (const vevents of groups.values()) {
    for (const ev of expandVEventGroup(vevents, rangeStart, rangeEnd, meta)) {
      const evStart = new Date(ev.start).getTime();
      const evEnd = ev.end ? new Date(ev.end).getTime() : evStart;
      if (evEnd >= startMs && evStart <= endMs) result.push(ev);
    }
  }
  return result;
}

function expandVEventGroup(vevents, rangeStart, rangeEnd, meta = {}) {
  if (vevents.length === 0) return [];

  const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
  const event = parseVEventToEvent(master, meta);
  if (!event) return [];

  if (!master.getFirstProperty('rrule') && !master.getFirstProperty('rdate')) {
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

  const rruleProp = master.getFirstProperty('rrule');
  const rruleStr = rruleProp ? rruleProp.toICALString() : '';
  const hasCount = /\bCOUNT=/i.test(rruleStr);

  let iterStart;
  const startJsDate = icalEvent.startDate ? icalEvent.startDate.toJSDate() : null;

  if (!hasCount && startJsDate && limitStart > startJsDate) {
    const rruleUpper = rruleStr.toUpperCase();
    const durationMs = icalEvent.duration ? (icalEvent.duration.toSeconds() * 1000) : (24 * 60 * 60 * 1000);
    // MINUTELY/SECONDLY walk every step of the lookback, so a two-day lookback
    // at INTERVAL=1 would exhaust maxIterations before reaching the window.
    // Two hours covers the wall-clock vs. elapsed-time skew across DST.
    const subDaily = /FREQ=(MINUTELY|SECONDLY)/.test(rruleUpper);
    const lookbackMs = durationMs + (subDaily ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000 * 2);
    const fastForwardDate = new Date(limitStart.getTime() - lookbackMs);

    if (fastForwardDate > startJsDate) {
      iterStart = icalEvent.startDate.clone();

      const match = rruleUpper.match(/INTERVAL=(\d+)/);
      const interval = match ? parseInt(match[1], 10) : 1;

      if (rruleUpper.includes('FREQ=YEARLY')) {
        const deltaYears = fastForwardDate.getUTCFullYear() - startJsDate.getUTCFullYear();
        // ical.js emits an invalid BYMONTHDAY date (Feb 29 outside leap years)
        // normalised to Mar 1, and whether it does depends on where the anchor
        // year sits in the leap cycle. Advance in steps of lcm(INTERVAL, 4) years
        // so the seed keeps DTSTART's leap-cycle phase, and stop one step short
        // so the anchor year's own normalised date lies before the window.
        const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
        const step = (interval * 4) / gcd(interval, 4);
        let stepsPassed = Math.floor(deltaYears / step) - 1;
        while (stepsPassed > 0 &&
               ICAL.Time.daysInMonth(iterStart.month, iterStart.year + (stepsPassed * step)) < iterStart.day) {
          stepsPassed--;
        }
        iterStart.year += Math.max(stepsPassed, 0) * step;
      } else if (rruleUpper.includes('FREQ=MONTHLY')) {
        const deltaMonths = (fastForwardDate.getUTCFullYear() - startJsDate.getUTCFullYear()) * 12 
                          + (fastForwardDate.getUTCMonth() - startJsDate.getUTCMonth());
        let intervalsPassed = Math.floor(deltaMonths / interval);
        // The seed must keep DTSTART's day-of-month: if the target month is too
        // short for it (e.g. the 31st in April), ICAL.Time would normalise the
        // seed into the next month and re-phase the series. Step back whole
        // INTERVALs until the month can hold the day; k=0 (DTSTART) always can.
        const startMonthIndex = (iterStart.year * 12) + (iterStart.month - 1);
        const monthHoldsDay = (index) =>
          ICAL.Time.daysInMonth((index % 12) + 1, Math.floor(index / 12)) >= iterStart.day;
        while (intervalsPassed > 0 && !monthHoldsDay(startMonthIndex + (intervalsPassed * interval))) {
          intervalsPassed--;
        }
        const targetIndex = startMonthIndex + (intervalsPassed * interval);
        iterStart.year = Math.floor(targetIndex / 12);
        iterStart.month = (targetIndex % 12) + 1;
      } else if (rruleUpper.includes('FREQ=WEEKLY')) {
        const deltaMs = fastForwardDate.getTime() - startJsDate.getTime();
        const deltaWeeks = deltaMs / (7 * 24 * 60 * 60 * 1000);
        const intervalsPassed = Math.floor(deltaWeeks / interval);
        iterStart.adjust(intervalsPassed * interval * 7, 0, 0, 0);
      } else if (rruleUpper.includes('FREQ=DAILY')) {
        const deltaMs = fastForwardDate.getTime() - startJsDate.getTime();
        const deltaDays = deltaMs / (24 * 60 * 60 * 1000);
        const intervalsPassed = Math.floor(deltaDays / interval);
        iterStart.adjust(intervalsPassed * interval, 0, 0, 0);
      } else if (rruleUpper.includes('FREQ=HOURLY')) {
        const deltaMs = fastForwardDate.getTime() - startJsDate.getTime();
        const deltaHours = deltaMs / (60 * 60 * 1000);
        const intervalsPassed = Math.floor(deltaHours / interval);
        iterStart.adjust(0, intervalsPassed * interval, 0, 0);
      } else if (rruleUpper.includes('FREQ=MINUTELY')) {
        const deltaMs = fastForwardDate.getTime() - startJsDate.getTime();
        const deltaMinutes = deltaMs / (60 * 1000);
        const intervalsPassed = Math.floor(deltaMinutes / interval);
        iterStart.adjust(0, 0, intervalsPassed * interval, 0);
      } else if (rruleUpper.includes('FREQ=SECONDLY')) {
        const deltaMs = fastForwardDate.getTime() - startJsDate.getTime();
        const deltaSeconds = deltaMs / 1000;
        const intervalsPassed = Math.floor(deltaSeconds / interval);
        iterStart.adjust(0, 0, 0, intervalsPassed * interval);
      }
    }
  }

  const iterator = icalEvent.iterator(iterStart);
  const instances = [];
  let next;
  let iterations = 0;
  const maxIterations = 50000;
  const maxCount = 500;

  while ((next = iterator.next()) && iterations < maxIterations && instances.length < maxCount) {
    iterations++;
    let details;
    try {
      details = icalEvent.getOccurrenceDetails(next);
    } catch (e) {
      continue;
    }
    const occStartIso = details.startDate.isDate ? icalTimeToISO(details.startDate) : details.startDate.toJSDate().toISOString();
    const occEndIso = details.endDate.isDate ? icalTimeToISO(details.endDate) : details.endDate.toJSDate().toISOString();

    const occStart = details.startDate.toJSDate();
    const occEnd = details.endDate.toJSDate();

    if (next.toJSDate().getTime() > limitEnd.getTime()) {
      break;
    }

    if (new Date(occEndIso).getTime() >= limitStart.getTime() && new Date(occStartIso).getTime() <= limitEnd.getTime()) {
      const recurrenceId = details.recurrenceId.toString();
      const isOverride = details.item.component !== master;
      const base = isOverride ? parseVEventToEvent(details.item.component, meta) : event;
      instances.push({
        ...base,
        uid: `${event.uid}::${recurrenceId}`,
        masterUid: event.uid,
        start: occStartIso,
        end: occEndIso,
        recurrenceId,
        recurrence: event.recurrence,
        alarms: base.alarms || event.alarms || []
      });
    }
  }

  return instances;
}

/**
 * Normalise a recurrence rule (RRULE) against the event's DTSTART.
 * Specifically, for weekly recurrences (FREQ=WEEKLY) with a single BYDAY,
 * ensure the BYDAY matches the day of the week of DTSTART (Issue #91).
 * Multi-day rules (e.g. BYDAY=MO,WE,FR) and monthly/yearly positional rules
 * (e.g. 2TH, -1SU) are preserved untouched.
 *
 * @param {string|null} recurrence - The RRULE string
 * @param {Date|ICAL.Time|string|null} dtstart - The start date/time of the event
 * @param {string|null} [timeZone] - The event's startTimeZone. A UTC instant is
 *   resolved to its weekday in this zone, because that is the zone DTSTART is
 *   written in (eventToICS). Without it the instant's UTC weekday is used.
 *   Pass null for all-day events: their DTSTART;VALUE=DATE is the UTC date.
 * @returns {string|null} - The normalised RRULE string
 */
function normalizeRecurrenceRule(recurrence, dtstart, timeZone = null) {
  if (!recurrence || typeof recurrence !== 'string') return recurrence;
  if (!dtstart) return recurrence;

  const hasRrulePrefix = /^RRULE:/i.test(recurrence.trim());
  const cleanRecur = recurrence.replace(/^RRULE:/i, '').trim();

  // Only weekly rules are subject to single-BYDAY weekday re-derivation
  if (!/(?:^|;)FREQ=WEEKLY(?:;|$)/i.test(cleanRecur)) {
    return recurrence;
  }

  // Extract BYDAY
  const bydayMatch = cleanRecur.match(/(?:^|;)BYDAY=([^;]+)/i);
  if (!bydayMatch) return recurrence;

  const rawByDay = bydayMatch[1].trim().toUpperCase();
  // Only single weekday without position (SU, MO, TU, WE, TH, FR, SA)
  const singleWeekdayRegex = /^(SU|MO|TU|WE|TH|FR|SA)$/;
  if (!singleWeekdayRegex.test(rawByDay)) {
    return recurrence;
  }

  const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  let targetWeekday = null;

  if (typeof dtstart.dayOfWeek === 'function') {
    targetWeekday = dayNames[dtstart.dayOfWeek() - 1];
  } else if (dtstart instanceof Date) {
    targetWeekday = isNaN(dtstart.getTime()) ? null : weekdayOfInstant(dtstart.toISOString(), timeZone);
  } else if (typeof dtstart === 'string') {
    const s = dtstart.trim().replace(/^.*:/, '');
    const clean = s.split('T')[0];
    if (/^\d{8}$/.test(clean)) {
      const y = Number(clean.slice(0, 4)), m = Number(clean.slice(4, 6)), d = Number(clean.slice(6, 8));
      targetWeekday = dayNames[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    } else if (/^\d{4}-\d{2}-\d{2}/.test(clean)) {
      const p = clean.split('-').map(Number);
      targetWeekday = dayNames[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    } else {
      const d = new Date(dtstart);
      targetWeekday = isNaN(d.getTime()) ? null : weekdayOfInstant(d.toISOString(), timeZone);
    }
  }

  if (targetWeekday && targetWeekday !== rawByDay) {
    const updated = cleanRecur.replace(/(^|;)BYDAY=[^;]+/i, `$1BYDAY=${targetWeekday}`);
    return hasRrulePrefix ? `RRULE:${updated}` : updated;
  }

  return recurrence;
}

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// The weekday of a FREQ=WEEKLY rule with exactly one plain BYDAY, else null.
function _singleWeeklyByday(recurrence) {
  if (!recurrence || typeof recurrence !== 'string') return null;
  const clean = recurrence.replace(/^RRULE:/i, '').trim();
  if (!/(?:^|;)FREQ=WEEKLY(?:;|$)/i.test(clean)) return null;
  const m = clean.match(/(?:^|;)BYDAY=(SU|MO|TU|WE|TH|FR|SA)(?:;|$)/i);
  return m ? m[1].toUpperCase() : null;
}

// Weekday (SU..SA) of a UTC instant as DTSTART will be written: in `timeZone`
// when eventToICS emits DTSTART;TZID=<timeZone>, otherwise in UTC.
function weekdayOfInstant(iso, timeZone) {
  const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  if (timeZone && isValidTimezone(timeZone) && !isTzidLossy(iso, timeZone)) {
    const local = fmtDateTimeTzid(iso, timeZone);
    const y = Number(local.slice(0, 4)), m = Number(local.slice(4, 6)), d = Number(local.slice(6, 8));
    return dayNames[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }
  return dayNames[new Date(iso).getUTCDay()];
}

function eventToICS(event, existingIcs = null) {
  // Validate before the existing-ICS branch, whose catch would otherwise swallow the rejection.
  for (const att of Array.isArray(event.attachments) ? event.attachments : []) {
    const url = att && (typeof att === 'string' ? att : att.url);
    if (url) assertSafeAttachmentUrl(url);
  }
  assertValidAlarms(event.alarms);
  const baseIcs = existingIcs || event.rawIcs || null;

  if (baseIcs && typeof baseIcs === 'string' && baseIcs.trim()) {
    try {
      const jcal = ICAL.parse(baseIcs);
      const comp = new ICAL.Component(jcal);
      const vevents = comp.getAllSubcomponents('vevent');
      if (vevents.length > 0) {
        const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
        const uid = event.uid || master.getFirstPropertyValue('uid') || `${uuidv4()}@freeshard.webcalendar`;

        const setPropValue = (name, val) => {
          if (val === null || val === undefined || val === '') {
            master.removeAllProperties(name);
          } else {
            const prop = master.getFirstProperty(name);
            if (prop) {
              prop.setValue(val);
            } else {
              master.addPropertyWithValue(name, val);
            }
          }
        };

        setPropValue('uid', uid);
        setPropValue('summary', event.title || 'Untitled');

        if ('description' in event) {
          if (event.description) setPropValue('description', event.description);
          else master.removeAllProperties('description');
        }
        if ('location' in event) {
          if (event.location) setPropValue('location', event.location);
          else master.removeAllProperties('location');
        }
        if ('status' in event) {
          if (event.status) setPropValue('status', String(event.status).toUpperCase());
          else master.removeAllProperties('status');
        }

        const setEventDateProp = (propName, isoVal, isAllDay, tzid) => {
          if (!isoVal) {
            master.removeAllProperties(propName);
            return;
          }
          master.removeAllProperties(propName);
          const dt = new Date(isoVal);
          if (isNaN(dt.getTime())) return;

          let timeVal;
          if (isAllDay) {
            let dateStr = fmtDate(isoVal);
            if (propName === 'dtend' && event.start) {
              const startStr = fmtDate(event.start);
              if (dateStr <= startStr) {
                const sDate = new Date(event.start);
                sDate.setUTCDate(sDate.getUTCDate() + 1);
                dateStr = fmtDate(sDate.toISOString());
              }
            }
            timeVal = ICAL.Time.fromDateString(`${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`);
            timeVal.isDate = true;
          } else {
            if (tzid && isValidTimezone(tzid) && !isTzidLossy(isoVal, tzid)) {
              _registerVTimezoneBlock(tzid, buildVTimezoneBlock(tzid));
              const formatted = fmtDateTimeTzid(isoVal, tzid);
              const y  = formatted.slice(0, 4);
              const m  = formatted.slice(4, 6);
              const d  = formatted.slice(6, 8);
              const hh = formatted.slice(9, 11);
              const mm = formatted.slice(11, 13);
              const ss = formatted.slice(13, 15);
              timeVal = ICAL.Time.fromDateTimeString(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
            } else {
              timeVal = ICAL.Time.fromJSDate(dt, true);
            }
          }
          const prop = new ICAL.Property(propName, master);
          if (tzid && !isAllDay && isValidTimezone(tzid) && !isTzidLossy(isoVal, tzid)) {
            prop.setParameter('tzid', tzid);
            if (timeVal) timeVal.isUtc = false;
          } else {
            prop.removeParameter('tzid');
          }
          prop.setValue(timeVal);
          master.addProperty(prop);
        };

        if (event.start !== undefined) {
          setEventDateProp('dtstart', event.start, event.allDay, event.startTimeZone);
        }
        if (event.duration) {
          master.removeAllProperties('dtend');
          master.removeAllProperties('duration');
          const durProp = new ICAL.Property('duration', master);
          durProp.setValue(String(event.duration));
          master.addProperty(durProp);
        } else if (event.end !== undefined) {
          master.removeAllProperties('duration');
          const endTimeZone = event.endTimeZone || (event.startTimeZone && isValidTimezone(event.startTimeZone) ? event.startTimeZone : null);
          setEventDateProp('dtend', event.end, event.allDay, endTimeZone);
        }

        // Recurrence (RRULE)
        if ('recurrence' in event && event.recurrence !== undefined) {
          if (event.recurrence) {
            const dtstartProp = master.getFirstProperty('dtstart');
            const dtstartTime = dtstartProp ? dtstartProp.getFirstValue() : null;
            const normRecur = normalizeRecurrenceRule(event.recurrence, dtstartTime || event.start, event.allDay ? null : event.startTimeZone);
            const rruleClean = String(normRecur).replace(/^RRULE:/i, '').trim();
            try {
              const recur = ICAL.Recur.fromString(rruleClean);
              const prop = master.getFirstProperty('rrule');
              if (prop) {
                prop.setValue(recur);
              } else {
                master.addPropertyWithValue('rrule', recur);
              }
            } catch (_) {
              setPropValue('rrule', normRecur);
            }
          } else {
            master.removeAllProperties('rrule');
          }
        } else if (event.start !== undefined) {
          const rruleProp = master.getFirstProperty('rrule');
          const dtstartProp = master.getFirstProperty('dtstart');
          if (rruleProp && dtstartProp) {
            const dtstartTime = dtstartProp.getFirstValue();
            const currRruleVal = rruleProp.getFirstValue();
            const currRruleStr = currRruleVal ? currRruleVal.toString() : rruleProp.toICALString();
            const normRrule = normalizeRecurrenceRule(currRruleStr, dtstartTime || event.start, event.allDay ? null : event.startTimeZone);
            if (normRrule && normRrule !== currRruleStr) {
              try {
                rruleProp.setValue(ICAL.Recur.fromString(normRrule.replace(/^RRULE:/i, '').trim()));
              } catch (_) {
                rruleProp.setValue(normRrule);
              }
            }
          }
        }

        // Organizer
        if ('organizer' in event) {
          if (event.organizer && event.organizer.email) {
            let orgProp = master.getFirstProperty('organizer');
            if (!orgProp) {
              orgProp = new ICAL.Property('organizer', master);
              master.addProperty(orgProp);
            }
            orgProp.setValue(`mailto:${String(event.organizer.email).replace(/[\r\n]/g, '')}`);
            if (event.organizer.name) {
              orgProp.setParameter('cn', event.organizer.name);
            } else {
              orgProp.removeParameter('cn');
            }
          } else if (event.organizer === null) {
            master.removeAllProperties('organizer');
          }
        }

        // Attendees: preserve existing attendee parameters (e.g. ROLE, CUTYPE, X-*)!
        if (Array.isArray(event.attendees)) {
          const existingProps = master.getAllProperties('attendee');
          const incomingMap = new Map();
          for (const att of event.attendees) {
            if (att && att.email) {
              incomingMap.set(att.email.toLowerCase().replace(/^mailto:/i, ''), att);
            }
          }

          for (const prop of existingProps) {
            const val = prop.getFirstValue();
            const valStr = typeof val === 'string' ? val : (val && val.toString ? val.toString() : '');
            const email = valStr.toLowerCase().replace(/^mailto:/i, '');
            if (incomingMap.has(email)) {
              const att = incomingMap.get(email);
              if (att.name) prop.setParameter('cn', att.name);
              else prop.removeParameter('cn');

              if (att.status) prop.setParameter('partstat', att.status.toUpperCase());

              if (att.rsvp !== undefined) {
                if (att.rsvp === true) prop.setParameter('rsvp', 'TRUE');
                else if (att.rsvp === false) prop.setParameter('rsvp', 'FALSE');
              }
              incomingMap.delete(email);
            } else {
              master.removeProperty(prop);
            }
          }

          for (const [email, att] of incomingMap.entries()) {
            const newProp = new ICAL.Property('attendee', master);
            newProp.setValue(`mailto:${email}`);
            if (att.name) newProp.setParameter('cn', att.name);
            newProp.setParameter('partstat', (att.status || 'NEEDS-ACTION').toUpperCase());
            newProp.setParameter('cutype', 'INDIVIDUAL');
            if (att.rsvp === true) {
              newProp.setParameter('rsvp', 'TRUE');
            } else if (att.rsvp === false) {
              newProp.setParameter('rsvp', 'FALSE');
            }
            master.addProperty(newProp);
          }
        }

        // Categories
        if ('categories' in event && event.categories !== undefined) {
          const rawCats = Array.isArray(event.categories)
            ? event.categories
            : (typeof event.categories === 'string' ? event.categories.split(',') : []);
          const normCats = rawCats.map(c => String(c).trim()).filter(Boolean);
          master.removeAllProperties('categories');
          if (normCats.length > 0) {
            const prop = new ICAL.Property('categories', master);
            prop.setValues(normCats);
            master.addProperty(prop);
          }
        }

        // Attachments
        if ('attachments' in event && event.attachments !== undefined) {
          const attachments = Array.isArray(event.attachments) ? event.attachments : [];
          master.removeAllProperties('attach');
          for (const att of attachments) {
            if (!att) continue;
            const url = typeof att === 'string' ? att : att.url;
            if (!url) continue;
            const attProp = new ICAL.Property('attach', master);
            attProp.setValue(url);
            if (typeof att === 'object') {
              if (att.mimeType) attProp.setParameter('fmttype', att.mimeType);
              if (att.name) attProp.setParameter('x-filename', att.name);
            }
            master.addProperty(attProp);
          }
        }

        // Alarms
        if ('alarms' in event && event.alarms !== undefined) {
          const stored = master.getAllSubcomponents('valarm')
            .map(comp => ({ comp, key: alarmIdentity(valarmToAlarm(comp, master)) }));
          master.removeAllSubcomponents('valarm');
          const alarms = Array.isArray(event.alarms) ? event.alarms : [];
          for (const alarm of alarms) {
            const keep = stored.findIndex(st => st.key === alarmIdentity(alarm));
            if (keep !== -1) {
              master.addSubcomponent(stored.splice(keep, 1)[0].comp);
              continue;
            }
            const alarmComp = new ICAL.Component('valarm', master);
            alarmComp.addPropertyWithValue('action', (alarm.action || 'DISPLAY').toUpperCase());
            alarmComp.addProperty(ICAL.Property.fromString(alarmTriggerLine(alarm)));
            if (alarm.description) alarmComp.addPropertyWithValue('description', alarm.description);
            master.addSubcomponent(alarmComp);
          }
        }

        // LAST-MODIFIED
        setEventDateProp('last-modified', new Date().toISOString(), false, null);

        // VTIMEZONE blocks
        // Same guard as the fresh-build path below: an unresolvable TZID gets
        // no VTIMEZONE at all (#203) — DTSTART/DTEND already fell back to UTC.
        const tzids = [];
        if (!event.allDay) {
          for (const tz of [event.startTimeZone, event.endTimeZone]) {
            if (!tz || tzids.includes(tz)) continue;
            if (isValidTimezone(tz)) tzids.push(tz);
            else console.warn(`[timezone] Invalid timezone "${tz}" omitted from ICS`);
          }
        }
        for (const tzid of tzids) {
          const existingTzs = comp.getAllSubcomponents('vtimezone');
          if (!existingTzs.some(t => t.getFirstPropertyValue('tzid') === tzid)) {
            const block = buildVTimezoneBlock(tzid);
            _registerVTimezoneBlock(tzid, block);
            const tzComp = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone');
            if (tzComp) comp.addSubcomponent(tzComp);
          }
        }

        return cleanMalformedTzidZ(comp.toString());
      }
    } catch (e) {
      console.warn('[eventToICS] Error updating existing ICS, falling back to new ICS generation:', e.message);
    }
  }

  const uid      = event.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp  = fmtDateTime(new Date().toISOString());

  // Collect unique TZID values that need VTIMEZONE blocks (non-allDay only)
  const tzids = [];
  if (!event.allDay) {
    if (event.startTimeZone && isValidTimezone(event.startTimeZone) && !tzids.includes(event.startTimeZone)) {
      tzids.push(event.startTimeZone);
    } else if (event.startTimeZone && !isValidTimezone(event.startTimeZone)) {
      console.warn(`[timezone] Invalid startTimeZone "${event.startTimeZone}" omitted from ICS`);
    }
    if (event.endTimeZone && isValidTimezone(event.endTimeZone) && !tzids.includes(event.endTimeZone)) {
      tzids.push(event.endTimeZone);
    } else if (event.endTimeZone && !isValidTimezone(event.endTimeZone)) {
      console.warn(`[timezone] Invalid endTimeZone "${event.endTimeZone}" omitted from ICS`);
    }
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar 1.0//EN',
    'CALSCALE:GREGORIAN'
  ];

  // Embed VTIMEZONE blocks before VEVENT (RFC 5545 §3.6.5)
  // Also register each timezone in ICAL.TimezoneService so that any
  // subsequent parse of this ICS (or the same TZID elsewhere) can resolve
  // TZID-qualified DTSTART/DTEND values without falling back to floating.
  for (const tzid of tzids) {
    const block = buildVTimezoneBlock(tzid);
    if (block) {
      lines.push(block);
      _registerVTimezoneBlock(tzid, block);
    }
  }

  lines.push(
    'BEGIN:VEVENT',
    `UID:${String(uid).replace(/[\r\n]/g, '')}`,
    `DTSTAMP:${dtstamp}`,
    `LAST-MODIFIED:${dtstamp}`,
    `SUMMARY:${escIcal(event.title || 'Untitled')}`
  );

  if (event.allDay) {
    const startStr = fmtDate(event.start);
    let endStr = fmtDate(event.end || event.start);
    if (endStr <= startStr) {
      const sDate = new Date(event.start);
      sDate.setUTCDate(sDate.getUTCDate() + 1);
      endStr = fmtDate(sDate.toISOString());
    }
    lines.push(`DTSTART;VALUE=DATE:${startStr}`);
    lines.push(`DTEND;VALUE=DATE:${endStr}`);
  } else if (event.duration) {
    let startFmt = null;
    if (event.startTimeZone && isValidTimezone(event.startTimeZone) && !isTzidLossy(event.start, event.startTimeZone)) {
      startFmt = fmtDateTimeTzid(event.start, event.startTimeZone);
      lines.push(`DTSTART;TZID=${escParamVal(event.startTimeZone)}:${startFmt}`);
    } else {
      startFmt = fmtDateTime(event.start);
      lines.push(`DTSTART:${startFmt}`);
    }
    lines.push(`DURATION:${String(event.duration).replace(/[\r\n]/g, '')}`);
  } else {
    let startFmt = null;
    if (event.startTimeZone && isValidTimezone(event.startTimeZone) && !isTzidLossy(event.start, event.startTimeZone)) {
      startFmt = fmtDateTimeTzid(event.start, event.startTimeZone);
      lines.push(`DTSTART;TZID=${escParamVal(event.startTimeZone)}:${startFmt}`);
    } else {
      startFmt = fmtDateTime(event.start);
      lines.push(`DTSTART:${startFmt}`);
    }

    const endTimeZone = event.endTimeZone || (event.startTimeZone && isValidTimezone(event.startTimeZone) ? event.startTimeZone : null);

    if (endTimeZone && isValidTimezone(endTimeZone) && !isTzidLossy(event.end, endTimeZone)) {
      const endFmt = fmtDateTimeTzid(event.end, endTimeZone);
      if (event.startTimeZone === endTimeZone && new Date(event.end) > new Date(event.start) && endFmt <= startFmt) {
        lines.push(`DTEND:${fmtDateTime(event.end)}`);
      } else {
        lines.push(`DTEND;TZID=${escParamVal(endTimeZone)}:${endFmt}`);
      }
    } else {
      lines.push(`DTEND:${fmtDateTime(event.end)}`);
    }
  }

  if (event.description) lines.push(`DESCRIPTION:${escIcal(event.description)}`);
  if (event.location)    lines.push(`LOCATION:${escIcal(event.location)}`);
  if (event.status)      lines.push(`STATUS:${String(event.status).replace(/[\r\n]/g, '')}`);

  if (event.organizer?.email) {
    const cn = event.organizer.name ? `;CN="${escParamVal(event.organizer.name)}"` : '';
    lines.push(`ORGANIZER${cn}:mailto:${String(event.organizer.email).replace(/[\r\n]/g, '')}`);
  }

  for (const att of (event.attendees || [])) {
    if (!att.email) continue;
    const cn       = att.name   ? `;CN="${escParamVal(att.name)}"`           : '';
    const partstat = `;PARTSTAT=${escParamVal(att.status || 'NEEDS-ACTION')}`;
    const rsvp     = att.rsvp === true ? ';RSVP=TRUE' : (att.rsvp === false ? ';RSVP=FALSE' : '');
    lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL${cn}${partstat}${rsvp}:mailto:${String(att.email).replace(/[\r\n]/g, '')}`);
  }

  if (event.recurrence) {
    const normRecur = normalizeRecurrenceRule(event.recurrence, event.start, event.allDay ? null : event.startTimeZone);
    lines.push(`RRULE:${String(normRecur).replace(/^RRULE:/i, '').replace(/[\r\n]/g, '')}`);
  }

  const alarms = Array.isArray(event.alarms) ? event.alarms : (event.valarm ? [event.valarm] : []);
  for (const alarm of alarms) {
    lines.push('BEGIN:VALARM');
    lines.push(`ACTION:${String(alarm.action || 'DISPLAY').replace(/[\r\n]/g, '')}`);
    lines.push(alarmTriggerLine(alarm));
    if (alarm.description) {
      lines.push(`DESCRIPTION:${escIcal(alarm.description)}`);
    }
    lines.push('END:VALARM');
  }

  const rawCats = Array.isArray(event.categories)
    ? event.categories
    : (typeof event.categories === 'string' ? event.categories.split(',') : []);
  const normCats = rawCats.map(c => String(c).trim()).filter(Boolean);
  if (normCats.length > 0) {
    lines.push(`CATEGORIES:${normCats.map(escIcal).join(',')}`);
  }

  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  for (const att of attachments) {
    if (!att) continue;
    const url = typeof att === 'string' ? att : att.url;
    if (!url) continue;
    const name = typeof att === 'object' && att.name ? att.name : null;
    const mimeType = typeof att === 'object' && att.mimeType ? att.mimeType : null;
    const fmt = mimeType ? `;FMTTYPE=${escParamVal(mimeType)}` : '';
    const fn = name ? `;X-FILENAME="${escParamVal(name)}"` : '';
    lines.push(`ATTACH${fmt}${fn}:${String(url).replace(/[\r\n]/g, '')}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return cleanMalformedTzidZ(foldLines(lines.join('\n')) + '\r\n');
}


function getMasterVEvent(comp) {
  const vevents = comp.getAllSubcomponents('vevent');
  const master = vevents.find(v => !v.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('NO_MASTER_EVENT');
  return master;
}

function occurrenceTime(master, recurrenceId) {
  const dtstartProp = master ? master.getFirstProperty('dtstart') : null;
  const dtstart = master ? master.getFirstPropertyValue('dtstart') : null;
  const isDate = dtstart ? dtstart.isDate : false;
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  const recStr = String(recurrenceId || '').trim();

  if (isDate) {
    const cleanStr = recStr.replace(/[-:]/g, '');
    const y = cleanStr.slice(0, 4);
    const m = cleanStr.slice(4, 6);
    const d = cleanStr.slice(6, 8);
    return ICAL.Time.fromDateString(`${y}-${m}-${d}`);
  }

  const isUtcStr = recStr.endsWith('Z') || recStr.includes('+') || (recStr.includes('T') && recStr.includes('-') && recStr.indexOf('-') > recStr.indexOf('T'));
  let parsableStr = recStr;
  if (/^\d{8}T\d{6}Z?$/i.test(recStr)) {
    const y = recStr.slice(0, 4);
    const m = recStr.slice(4, 6);
    const d = recStr.slice(6, 8);
    const hh = recStr.slice(9, 11);
    const mm = recStr.slice(11, 13);
    const ss = recStr.slice(13, 15);
    const z = recStr.toUpperCase().endsWith('Z') ? 'Z' : '';
    parsableStr = `${y}-${m}-${d}T${hh}:${mm}:${ss}${z}`;
  }

  const jsDate = new Date(parsableStr);
  const targetZone = dtstart ? dtstart.zone : (tzid ? ICAL.TimezoneService.get(tzid) : null);

  if ((isUtcStr || recStr.toUpperCase().endsWith('Z')) && !isNaN(jsDate.getTime())) {
    const tUtc = ICAL.Time.fromJSDate(jsDate, true);
    if (targetZone) {
      return tUtc.convertToZone(targetZone);
    }
    return tUtc;
  }

  let time;
  if (recStr.includes('-') && recStr.includes(':')) {
    time = ICAL.Time.fromString(recStr);
  } else {
    const clean = recStr.replace(/[-:]/g, '');
    const y = clean.slice(0, 4);
    const m = clean.slice(4, 6);
    const d = clean.slice(6, 8);
    const hh = clean.slice(9, 11) || '00';
    const mm = clean.slice(11, 13) || '00';
    const ss = clean.slice(13, 15) || '00';
    time = ICAL.Time.fromDateTimeString(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  }

  if (targetZone && !time.isDate) {
    time.zone = targetZone;
  }
  return time;
}

function removeOverride(comp, recurrenceId) {
  _registerEmbeddedTimezones(comp);
  const normTarget = String(recurrenceId || '').replace(/[-:]/g, '').toUpperCase();
  const master = comp.getAllSubcomponents('vevent').find(v => !v.getFirstProperty('recurrence-id'));
  const targetTime = master && recurrenceId ? occurrenceTime(master, recurrenceId) : null;
  const targetUtcMs = targetTime ? targetTime.toJSDate().getTime() : null;

  for (const v of comp.getAllSubcomponents('vevent')) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (!rid) continue;
    const str = rid.toICALString ? rid.toICALString() : rid.toString();
    const normStr = str.replace(/[-:]/g, '').toUpperCase();
    if (normStr === normTarget) {
      comp.removeSubcomponent(v);
      continue;
    }
    if (targetUtcMs !== null && typeof rid.toJSDate === 'function') {
      const ridProp = v.getFirstProperty('recurrence-id');
      const ridTzid = ridProp ? ridProp.getParameter('tzid') : null;
      if (ridTzid && !rid.zone) {
        const zone = ICAL.TimezoneService.get(ridTzid);
        if (zone) rid.zone = zone;
      }
      if (rid.toJSDate().getTime() === targetUtcMs) {
        comp.removeSubcomponent(v);
      }
    }
  }
}

function addOccurrenceException(icsString, recurrenceId) {
  const comp = new ICAL.Component(ICAL.parse(icsString));
  _registerEmbeddedTimezones(comp);
  const master = getMasterVEvent(comp);

  removeOverride(comp, recurrenceId);

  const time = occurrenceTime(master, recurrenceId);
  const prop = new ICAL.Property('exdate', master);
  const dtstartProp = master.getFirstProperty('dtstart');
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  if (tzid && !time.isUtc && isValidTimezone(tzid)) {
    prop.setParameter('tzid', tzid);
  } else {
    prop.removeParameter('tzid');
  }
  prop.setValue(time);
  master.addProperty(prop);

  return cleanMalformedTzidZ(comp.toString());
}

function upsertOccurrenceOverride(icsString, recurrenceId, eventData) {
  const comp = new ICAL.Component(ICAL.parse(icsString));
  _registerEmbeddedTimezones(comp);
  const master = getMasterVEvent(comp);
  const masterUid = master.getFirstPropertyValue('uid');

  removeOverride(comp, recurrenceId);

  const overrideIcs = eventToICS({ ...eventData, uid: masterUid, recurrence: null });
  const overrideComp = new ICAL.Component(ICAL.parse(overrideIcs));
  const override = overrideComp.getFirstSubcomponent('vevent');

  // Carry the override's VTIMEZONE blocks over, or its TZID params dangle (#238/#52).
  for (const tz of overrideComp.getAllSubcomponents('vtimezone')) {
    const tzid = tz.getFirstPropertyValue('tzid');
    if (!comp.getAllSubcomponents('vtimezone').some(t => t.getFirstPropertyValue('tzid') === tzid)) {
      comp.addSubcomponent(tz);
    }
  }

  const rid = new ICAL.Property('recurrence-id', override);
  const dtstartProp = master.getFirstProperty('dtstart');
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  const ridTime = occurrenceTime(master, recurrenceId);
  if (tzid && !ridTime.isUtc && isValidTimezone(tzid)) {
    rid.setParameter('tzid', tzid);
  } else {
    rid.removeParameter('tzid');
  }
  rid.setValue(ridTime);
  override.addProperty(rid);

  comp.addSubcomponent(override);
  return cleanMalformedTzidZ(comp.toString());
}

/**
 * Detach one occurrence of the series in `comp` as an exact copy of the master,
 * moved to that occurrence: DTSTART becomes the occurrence start and DTEND keeps
 * the master's wall-clock duration (a DURATION property carries over as is).
 * Returns the new override VEVENT, already added to `comp`.
 */
function cloneOccurrenceOverride(comp, recurrenceId) {
  _registerEmbeddedTimezones(comp);
  const master = getMasterVEvent(comp);
  const override = new ICAL.Component(JSON.parse(JSON.stringify(master.jCal)));
  for (const name of ['rrule', 'rdate', 'exdate']) override.removeAllProperties(name);

  const masterEvent = new ICAL.Event(master);
  const start = occurrenceTime(master, recurrenceId);
  const dtstartProp = master.getFirstProperty('dtstart');
  const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
  const keepTzid = tzid && !start.isUtc && isValidTimezone(tzid);

  const rid = new ICAL.Property('recurrence-id', override);
  if (keepTzid) rid.setParameter('tzid', tzid);
  rid.setValue(start);
  override.addProperty(rid);

  override.getFirstProperty('dtstart').setValue(start.clone());

  const dtendProp = override.getFirstProperty('dtend');
  if (dtendProp) {
    const end = start.clone();
    end.addDuration(masterEvent.endDate.subtractDate(masterEvent.startDate));
    const endTzid = dtendProp.getParameter('tzid');
    if (endTzid && isValidTimezone(endTzid) && !end.isDate) {
      dtendProp.setValue(end.convertToZone(ICAL.TimezoneService.get(endTzid)));
    } else {
      dtendProp.setValue(end);
    }
  }

  comp.addSubcomponent(override);
  return override;
}

function escParamVal(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\r\n]/g, '')
    .replace(/\^/g, '^^')
    .replace(/"/g, "^'");
}

function escIcal(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function fmtDateTime(iso) {
  if (typeof iso === 'string') {
    const timePart = iso.split('T')[1] || '';
    if (!iso.endsWith('Z') && !timePart.includes('+') && !timePart.includes('-')) {
      return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    }
  }
  return new Date(iso).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function fmtDateTimeTzid(iso, tzid) {
  if (!isValidTimezone(tzid)) {
    console.warn(`[timezone] Invalid tzid "${tzid}" passed to fmtDateTimeTzid, falling back to UTC formatting`);
    return fmtDateTime(iso);
  }
  try {
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
  } catch (err) {
    console.warn(`[timezone] Failed formatting date for tzid "${tzid}":`, err.message);
    return fmtDateTime(iso);
  }
}

function getUtcDate(dateStr, timeStr, timeZone) {
  if (!dateStr) return new Date();
  const iso = `${dateStr}T${timeStr || '00:00'}:00.000Z`;
  const temp = new Date(iso);
  if (isNaN(temp.getTime())) return temp;

  if (!timeZone || !isValidTimezone(timeZone)) return temp;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const getPartMap = (d) => {
    const parts = formatter.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.hour === '24') map.hour = '00';
    return map;
  };

  const partMap = getPartMap(temp);
  const localIso = `${partMap.year}-${partMap.month}-${partMap.day}T${partMap.hour}:${partMap.minute}:${partMap.second}.000Z`;
  const localTemp = new Date(localIso);
  const diff = temp.getTime() - localTemp.getTime();
  const targetMs = temp.getTime() + diff;

  // Re-check targetMs in target timeZone to handle DST changeover offset shifts
  const targetPartMap = getPartMap(new Date(targetMs));
  const targetLocalIso = `${targetPartMap.year}-${targetPartMap.month}-${targetPartMap.day}T${targetPartMap.hour}:${targetPartMap.minute}:${targetPartMap.second}.000Z`;
  const targetLocalTemp = new Date(targetLocalIso);
  const secondDiff = temp.getTime() - targetLocalTemp.getTime();

  return new Date(targetMs + secondDiff);
}

function isTzidLossy(iso, tzid) {
  if (!iso || !tzid || !isValidTimezone(tzid)) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;

  const tzidFmt = fmtDateTimeTzid(iso, tzid);
  if (!tzidFmt || tzidFmt.length < 15) return false;
  const y = tzidFmt.slice(0, 4);
  const m = tzidFmt.slice(4, 6);
  const day = tzidFmt.slice(6, 8);
  const hh = tzidFmt.slice(9, 11);
  const mm = tzidFmt.slice(11, 13);
  const dateStr = `${y}-${m}-${day}`;
  const timeStr = `${hh}:${mm}`;

  const resolvedUtc = getUtcDate(dateStr, timeStr, tzid);
  if (resolvedUtc.getTime() !== d.getTime()) return true;

  const deltasMs = [3600000, -3600000, 1800000, -1800000, 7200000, -7200000, 2700000, -2700000];
  for (const delta of deltasMs) {
    const neighborIso = new Date(d.getTime() + delta).toISOString();
    if (fmtDateTimeTzid(neighborIso, tzid) === tzidFmt) {
      return true;
    }
  }

  return false;
}

function fmtDate(iso) {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
}

function foldLines(text) {
  return text.split('\n').map(line => {
    line = line.replace(/\r$/, '');
    if (Buffer.byteLength(line, 'utf8') <= 75) return line;

    const parts = [];
    let currentChunk = '';
    let currentBytes = 0;
    let maxBytes = 75;

    for (const char of line) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (currentBytes + charBytes > maxBytes) {
        parts.push(currentChunk);
        currentChunk = char;
        currentBytes = charBytes;
        maxBytes = 74;
      } else {
        currentChunk += char;
        currentBytes += charBytes;
      }
    }
    if (currentChunk.length > 0) {
      parts.push(currentChunk);
    }

    return parts.map((part, index) => (index === 0 ? part : ' ' + part)).join('\r\n');
  }).join('\r\n');
}

function isValidTimezone(tzid) {
  if (!tzid || typeof tzid !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

function cleanMalformedTzidZ(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/;TZID=([^:]+):(\d{8}T\d{6})Z/gi, ';TZID=$1:$2');
}

function _registerEmbeddedTimezones(comp) {
  if (!comp || !comp.getAllSubcomponents) return;
  const vtimezones = comp.getAllSubcomponents('vtimezone');
  for (const vtz of vtimezones) {
    try {
      const tzid = vtz.getFirstPropertyValue('tzid');
      if (tzid && !ICAL.TimezoneService.has(tzid)) {
        ICAL.TimezoneService.register(vtz);
      }
    } catch (e) {
      console.warn('[timezone] Failed to register embedded VTIMEZONE:', e.message);
    }
  }

  const subcomps = [...comp.getAllSubcomponents('vevent'), ...comp.getAllSubcomponents('vtodo')];
  const datePropNames = ['dtstart', 'dtend', 'due', 'recurrence-id', 'exdate', 'rdate'];
  for (const sub of subcomps) {
    for (const name of datePropNames) {
      for (const prop of sub.getAllProperties(name)) {
        const tzid = prop.getParameter('tzid');
        if (tzid && isValidTimezone(tzid) && !ICAL.TimezoneService.has(tzid)) {
          _registerVTimezoneBlock(tzid, buildVTimezoneBlock(tzid));
        }
      }
    }
  }
}

/**
 * Compute the UTC offset in minutes for a given IANA timezone at a given Date.
 * Uses Intl.DateTimeFormat 'longOffset' to extract the GMT±HH:MM string.
 * @param {string} tzid - IANA timezone identifier
 * @param {Date}   date - reference date
 * @returns {number} offset in minutes (positive = east of UTC)
 */
function _tzOffsetMinutes(tzid, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      timeZoneName: 'longOffset',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    });
    const tzPart = fmt.formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT';
    if (tzPart === 'GMT' || tzPart === 'UTC') return 0;
    const m = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
  } catch (err) {
    console.warn(`[timezone] Invalid or unsupported IANA timezone identifier "${tzid}":`, err.message);
    return 0;
  }
}

/**
 * Format a UTC offset in minutes to ±HHMM string (e.g., +0100, -0500).
 * @param {number} offsetMins
 * @returns {string}
 */
function _fmtOffset(offsetMins) {
  const sign = offsetMins >= 0 ? '+' : '-';
  const abs  = Math.abs(offsetMins);
  const h    = String(Math.floor(abs / 60)).padStart(2, '0');
  const m    = String(abs % 60).padStart(2, '0');
  return `${sign}${h}${m}`;
}

/**
 * Build a RFC 5545-compliant VTIMEZONE component for the given IANA timezone.
 *
 * Strategy: Use two reference dates (mid-January for standard/winter time,
 * mid-July for daylight/summer time) to determine DST offsets via
 * Intl.DateTimeFormat.  If both offsets are identical the timezone has no DST
 * and only a STANDARD sub-component is emitted.  When DST exists, both a
 * STANDARD and a DAYLIGHT sub-component are emitted.
 *
 * The DTSTART and TZOFFSET values are derived from actual Intl data, preventing
 * cumulative timezone drift when ical.js parses the resulting ICS.
 *
 * @param {string} tzid - IANA timezone identifier (e.g., 'Europe/Berlin')
 * @returns {string|null} Multi-line VTIMEZONE block (lines joined with \r\n) or null if invalid
 */
function _getRuleForDate(date) {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let nth;
  if (day <= 7) nth = '1SU';
  else if (day <= 14) nth = '2SU';
  else if (day <= 21) nth = '3SU';
  else nth = '-1SU';
  return `BYMONTH=${month};BYDAY=${nth}`;
}

function _findExactTransitions(tzid, year = 2026) {
  let prevOffset = _tzOffsetMinutes(tzid, new Date(Date.UTC(year, 0, 1, 0, 0)));
  const transitions = [];
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const testDate = new Date(Date.UTC(year, m, d, 12, 0, 0));
      if (testDate.getUTCMonth() !== m) break;
      const offset = _tzOffsetMinutes(tzid, testDate);
      if (offset !== prevOffset) {
        for (let h = 0; h < 24; h++) {
          const hourDate = new Date(Date.UTC(year, m, d, h, 0, 0));
          const hOffset = _tzOffsetMinutes(tzid, hourDate);
          if (hOffset !== prevOffset) {
            transitions.push({
              date: hourDate,
              from: prevOffset,
              to: hOffset,
              rule: _getRuleForDate(hourDate)
            });
            prevOffset = hOffset;
            break;
          }
        }
      }
    }
  }
  return transitions;
}

/**
 * Build an RFC 5545-compliant VTIMEZONE component for the given IANA timezone.
 *
 * Dynamically computes exact DST transition dates, offsets, and RRULE expressions
 * using Intl.DateTimeFormat data to prevent timezone drift across DST boundaries.
 *
 * @param {string} tzid - IANA timezone identifier (e.g., 'Europe/Berlin')
 * @returns {string|null} Multi-line VTIMEZONE block (lines joined with \r\n) or null if invalid
 */
function buildVTimezoneBlock(tzid) {
  if (!isValidTimezone(tzid)) {
    console.warn(`[timezone] Invalid or unsupported IANA timezone identifier "${tzid}"`);
    return null;
  }

  const transitions = _findExactTransitions(tzid, 2026);
  if (transitions.length === 0) {
    const offset = _tzOffsetMinutes(tzid, new Date('2026-01-15T12:00:00Z'));
    return [
      'BEGIN:VTIMEZONE',
      `TZID:${tzid}`,
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${_fmtOffset(offset)}`,
      `TZOFFSETTO:${_fmtOffset(offset)}`,
      'END:STANDARD',
      'END:VTIMEZONE'
    ].join('\r\n');
  }

  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];
  for (const tr of transitions) {
    const isDaylight = tr.to > tr.from;
    const type = isDaylight ? 'DAYLIGHT' : 'STANDARD';
    const monthStr = String(tr.date.getUTCMonth() + 1).padStart(2, '0');
    const dayStr = String(tr.date.getUTCDate()).padStart(2, '0');
    const dtstart = `1970${monthStr}${dayStr}T020000`;
    lines.push(`BEGIN:${type}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`RRULE:FREQ=YEARLY;${tr.rule}`);
    lines.push(`TZOFFSETFROM:${_fmtOffset(tr.from)}`);
    lines.push(`TZOFFSETTO:${_fmtOffset(tr.to)}`);
    lines.push(`END:${type}`);
  }
  lines.push('END:VTIMEZONE');

  return lines.join('\r\n');
}

/**
 * Register a VTIMEZONE block string in ICAL.TimezoneService so that ical.js
 * can resolve TZID-qualified DTSTART/DTEND values during subsequent parses.
 *
 * This is idempotent — if the timezone is already registered (or registration
 * fails for any reason) the call is silently skipped.
 *
 * @param {string} tzid  - IANA timezone identifier
 * @param {string} block - VTIMEZONE block as returned by buildVTimezoneBlock
 */
function _registerVTimezoneBlock(tzid, block) {
  if (!tzid || !block) return;
  if (ICAL.TimezoneService.has(tzid)) return;
  try {
    const wrapper = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block}\r\nEND:VCALENDAR\r\n`;
    const wrapComp = new ICAL.Component(ICAL.parse(wrapper));
    const vtimezone = wrapComp.getFirstSubcomponent('vtimezone');
    if (vtimezone) {
      ICAL.TimezoneService.register(vtimezone);
    }
  } catch (e) {
    // Non-fatal: ICS output is still valid; ical.js will fall back to
    // floating if timezone resolution fails during parse.
    console.warn(`[ical] Ignoring unusable VTIMEZONE ${tzid}: ${e.message}`);
  }
}

function ridsMatch(r1, r2) {
  if (!r1 || !r2) return false;
  if (r1 === r2) return true;
  const n1 = String(r1).replace(/\.\d{3}/, '').replace(/[-:]/g, '').toUpperCase();
  const n2 = String(r2).replace(/\.\d{3}/, '').replace(/[-:]/g, '').toUpperCase();
  if (n1 === n2) return true;
  if (n1.replace(/Z$/, '') === n2.replace(/Z$/, '')) return true;
  const d1 = new Date(r1).getTime();
  const d2 = new Date(r2).getTime();
  if (!isNaN(d1) && !isNaN(d2) && d1 === d2) return true;
  return false;
}

/**
 * Determine whether a proposed event save would make no effective change to
 * the event stored at the CalDAV server.
 *
 * Compares the significant user-editable fields of `incomingEventData` against
 * the parsed content of `existingIcs`.  Volatile fields (DTSTAMP, LAST-MODIFIED,
 * ETag) are explicitly excluded so that a round-trip through the modal without
 * edits is always considered a no-op.
 *
 * Safe-default contract: if `existingIcs` is null/empty/unparseable this
 * function returns `false` so the caller always proceeds with the PUT rather
 * than silently swallowing a potentially valid save.
 *
 * @param {string|null} existingIcs - Current ICS content from the CalDAV server
 * @param {Object}      incomingEventData - Event payload from the PUT request body
 * @returns {boolean} true if the save is a no-op (nothing would change)
 */
function isNoOpEventSave(existingIcs, incomingEventData, recurrenceId = null) {
  if (!existingIcs || typeof existingIcs !== 'string' || !existingIcs.trim()) {
    return false;
  }

  const incoming = incomingEventData || {};
  const targetRid = recurrenceId || incoming.recurrenceId || (incoming.uid && incoming.uid.includes('::') ? incoming.uid.split('::')[1] : null);

  let stored;
  try {
    stored = parseICSToEvent(existingIcs, { recurrenceId: targetRid });
  } catch (_) {
    return false;
  }

  const toUtcMs = (v) => {
    if (!v) return null;
    const ms = new Date(v).getTime();
    return isNaN(ms) ? null : ms;
  };

  if (!stored && targetRid) {
    const incStartMs = toUtcMs(incoming.start);
    if (incStartMs) {
      let ridMs = null;
      if (!isNaN(new Date(targetRid).getTime())) {
        ridMs = new Date(targetRid).getTime();
      }
      const minMs = ridMs ? Math.min(incStartMs, ridMs) : incStartMs;
      const maxMs = ridMs ? Math.max(incStartMs, ridMs) : incStartMs;
      const searchStart = new Date(minMs - 48 * 3600 * 1000).toISOString();
      const searchEnd   = new Date(maxMs + 48 * 3600 * 1000).toISOString();
      const expanded = parseAndExpandEvent(existingIcs, searchStart, searchEnd);
      const match = expanded.find(e => ridsMatch(e.recurrenceId, targetRid) || toUtcMs(e.start) === incStartMs);
      if (match) {
        stored = match;
      }
    }
  }

  if (!stored) return false;

  // ── Title ────────────────────────────────────────────────────────────────
  const storedTitle    = (stored.title    || '').trim();
  const incomingTitle  = (incoming.title  || '').trim();
  if (storedTitle !== incomingTitle) return false;

  // ── Start / End (compare UTC instants; null == null is ok) ───────────────
  let expectedStartUtcMs = toUtcMs(stored.start);
  let expectedEndUtcMs   = toUtcMs(stored.end);

  if (targetRid && stored.recurrence) {
    const incStartMs = toUtcMs(incoming.start);
    let ridMs = null;
    if (!isNaN(new Date(targetRid).getTime())) {
      ridMs = new Date(targetRid).getTime();
    }
    const minMs = ridMs ? Math.min(incStartMs, ridMs) : incStartMs;
    const maxMs = ridMs ? Math.max(incStartMs, ridMs) : incStartMs;
    const searchStart = new Date(minMs - 48 * 3600 * 1000).toISOString();
    const searchEnd   = new Date(maxMs + 48 * 3600 * 1000).toISOString();
    const expanded = parseAndExpandEvent(existingIcs, searchStart, searchEnd);
    const match = expanded.find(e => ridsMatch(e.recurrenceId, targetRid) || toUtcMs(e.start) === incStartMs);
    if (match) {
      expectedStartUtcMs = toUtcMs(match.start);
      expectedEndUtcMs   = toUtcMs(match.end);
    }
  }

  if (expectedStartUtcMs !== toUtcMs(incoming.start)) return false;
  if (expectedEndUtcMs   !== toUtcMs(incoming.end))   return false;

  // ── AllDay ───────────────────────────────────────────────────────────────
  if (!!stored.allDay !== !!incoming.allDay) return false;

  // ── Description ──────────────────────────────────────────────────────────
  const storedDesc   = (stored.description   || '').trim();
  const incomingDesc = (incoming.description || '').trim();
  if (storedDesc !== incomingDesc) return false;

  // ── Location ─────────────────────────────────────────────────────────────
  const storedLoc   = (stored.location   || '').trim();
  const incomingLoc = (incoming.location || '').trim();
  if (storedLoc !== incomingLoc) return false;

  // ── Recurrence (RRULE) ───────────────────────────────────────────────────
  // This is the primary guard: if the caller strips/changes the RRULE the
  // comparison must catch it and allow the save to proceed.
  const normalizeRrule = (r) => (r || '').replace(/^RRULE:/i, '').trim().toUpperCase();
  if (normalizeRrule(stored.recurrence) !== normalizeRrule(incoming.recurrence)) return false;

  // ── Attendees ────────────────────────────────────────────────────────────
  // Compare canonical attendee representation (email + partstat only).
  const attendeeKey = (a) => `${(a.email || '').toLowerCase()}:${(a.status || '').toUpperCase()}`;
  const sortedAttendees = (arr) =>
    (arr || []).map(attendeeKey).sort().join('|');
  if (sortedAttendees(stored.attendees) !== sortedAttendees(incoming.attendees)) return false;

  // ── Alarms (VALARM) ──────────────────────────────────────────────────────
  const alarmKey = (a) => `${(a.action || '').toUpperCase()}:${String(a.related || 'START').toUpperCase()}:${(a.trigger || '').trim()}`;
  const sortedAlarms = (arr) =>
    (arr || []).map(alarmKey).sort().join('|');
  if (sortedAlarms(stored.alarms) !== sortedAlarms(incoming.alarms)) return false;

  // ── Categories (CATEGORIES) ──────────────────────────────────────────────
  const normCatsStr = (arr) => {
    const list = Array.isArray(arr) ? arr : (typeof arr === 'string' ? arr.split(',') : []);
    return list.map(c => String(c).trim().toUpperCase()).filter(Boolean).sort().join('|');
  };
  if (normCatsStr(stored.categories) !== normCatsStr(incoming.categories)) return false;

  return true;
}

// Comparison keys for the per-occurrence content fields of an event, used to
// tell an edited field from one the modal merely echoed back (#242).
const _textKey = (v) => (v == null ? '' : String(v).trim());
const _listKey = (fn) => (arr) => (Array.isArray(arr) ? arr : []).map(fn).sort().join('|');
const SERIES_FIELD_KEYS = {
  title:         _textKey,
  location:      _textKey,
  description:   _textKey,
  status:        _textKey,
  startTimeZone: _textKey,
  endTimeZone:   _textKey,
  allDay:        (v) => String(!!v),
  categories:    (v) => _listKey(c => String(c).trim().toUpperCase())(typeof v === 'string' ? v.split(',') : v),
  attendees:     _listKey(a => `${(a.email || '').toLowerCase()}:${(a.status || '').toUpperCase()}`),
  alarms:        _listKey(a => `${(a.action || '').toUpperCase()}:${String(a.related || 'START').toUpperCase()}:${(a.trigger || '').trim()}`),
  attachments:   _listKey(a => String(a.url || '').trim())
};

function _floatingCopy(t) {
  return ICAL.Time.fromData({
    year: t.year, month: t.month, day: t.day,
    hour: t.hour, minute: t.minute, second: t.second, isDate: t.isDate
  });
}

const SERIES_INSTANT_MAX_ITERATIONS = 50000;

// Unix times of every instance the master's DTSTART, RDATEs and RRULEs
// (EXDATE ignored) produce up to `untilUnix`. Throws rather than guessing when
// a rule is too dense to walk that far.
function _seriesInstants(master, untilUnix) {
  const dtstart = master.getFirstPropertyValue('dtstart');
  const out = new Set([dtstart.toUnixTime()]);
  for (const p of master.getAllProperties('rdate')) {
    for (const v of p.getValues()) {
      if (v instanceof ICAL.Time) out.add(v.toUnixTime());
    }
  }
  for (const rrule of master.getAllProperties('rrule').map(p => p.getFirstValue())) {
    const it = rrule.iterator(dtstart);
    let iterations = 0;
    let next;
    while ((next = it.next())) {
      const t = next.toUnixTime();
      if (t > untilUnix) break;
      out.add(t);
      if (++iterations >= SERIES_INSTANT_MAX_ITERATIONS) {
        throw new Error('Recurrence rule too dense to verify the series exceptions; save refused');
      }
    }
  }
  return out;
}

// After a series save, EXDATE values and RECURRENCE-ID overrides still name
// instants of the old DTSTART/RRULE. Each one is kept if the new rule still
// generates it, else moved by DTSTART's wall-clock delta if that lands on a
// generated instant, else dropped — so the stored file never holds an
// exception the expander silently ignores (#243).
function _reconcileSeriesExceptions(comp, oldMaster, newMaster) {
  const recurs = (v) => v.hasProperty('rrule') || v.hasProperty('rdate');
  if (!recurs(oldMaster) && !recurs(newMaster)) return;
  const origDtstart = oldMaster.getFirstPropertyValue('dtstart');
  const newDtstart = newMaster.getFirstPropertyValue('dtstart');
  if (!newDtstart) return;
  const uid = newMaster.getFirstPropertyValue('uid');

  let delta = null;
  if (origDtstart && origDtstart.isDate === newDtstart.isDate) {
    const d = _floatingCopy(newDtstart).subtractDate(_floatingCopy(origDtstart));
    if (d.toSeconds() !== 0) delta = d;
  }
  const shifted = (t) => {
    if (!delta) return t;
    const c = t.clone();
    c.addDuration(delta);
    return c;
  };

  const exdateProps = newMaster.getAllProperties('exdate');
  const overrides = comp.getAllSubcomponents('vevent')
    .filter(v => v.hasProperty('recurrence-id') && v.getFirstPropertyValue('uid') === uid);
  const candidates = [
    ...exdateProps.flatMap(p => p.getValues()),
    ...overrides.map(v => v.getFirstPropertyValue('recurrence-id'))
  ];
  if (candidates.length === 0) return;
  const until = Math.max(...candidates.flatMap(t => [t.toUnixTime(), shifted(t).toUnixTime()]));
  const generated = _seriesInstants(newMaster, until);
  const resolve = (t) => {
    if (generated.has(t.toUnixTime())) return t;
    const s = shifted(t);
    return s !== t && generated.has(s.toUnixTime()) ? s : null;
  };

  for (const prop of exdateProps) {
    const kept = prop.getValues().map(resolve).filter(Boolean);
    if (kept.length === 0) {
      newMaster.removeProperty(prop);
    } else {
      prop.setValues(kept);
    }
  }

  for (const ovr of overrides) {
    const ridProp = ovr.getFirstProperty('recurrence-id');
    const oldRid = ridProp.getFirstValue();
    const newRid = resolve(oldRid);
    if (!newRid) {
      comp.removeSubcomponent(ovr);
      continue;
    }
    if (newRid === oldRid) continue;
    // An override still sitting at its own slot was not moved by the user,
    // so it follows the series; one moved elsewhere keeps its time.
    const ovStart = ovr.getFirstPropertyValue('dtstart');
    if (ovStart && ovStart.toUnixTime() === oldRid.toUnixTime()) {
      for (const name of ['dtstart', 'dtend']) {
        const p = ovr.getFirstProperty(name);
        if (p) p.setValue(shifted(p.getFirstValue()));
      }
    }
    ridProp.setValue(newRid);
  }
}

/**
 * Update a whole event series while preserving any existing EXDATE properties
 * on the master VEVENT and any detached override VEVENT subcomponents.
 *
 * @param {string|null} existingIcs - The raw ICS string currently stored on the server
 * @param {Object}      eventData   - Updated event properties for the master VEVENT
 * @returns {string}                - Updated raw ICS string
 */

function updateWholeSeries(existingIcs, eventData) {
  if (!existingIcs || typeof existingIcs !== 'string' || !existingIcs.trim()) {
    return eventToICS(eventData);
  }

  let comp;
  try {
    const jcal = ICAL.parse(existingIcs);
    comp = new ICAL.Component(jcal);
    _registerEmbeddedTimezones(comp);
  } catch (e) {
    return eventToICS(eventData);
  }

  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) {
    return eventToICS(eventData);
  }

  const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
  const origMasterEv = parseVEventToEvent(master);
  const exdateProps = master.getAllProperties('exdate');
  // A stored weekly rule whose single BYDAY is not DTSTART's weekday (e.g. an
  // imported series anchored off-pattern) does not track DTSTART, so it must
  // not be re-derived from it (#238).
  const origDtstartTime = master.getFirstPropertyValue('dtstart');
  const origRrule = master.getFirstPropertyValue('rrule');
  const origByday = origRrule ? _singleWeeklyByday(origRrule.toString()) : null;
  const offPatternByday = !!(origByday && origDtstartTime
    && origByday !== WEEKDAY_NAMES[origDtstartTime.dayOfWeek() - 1]);

  let masterEventData = {
    startTimeZone: origMasterEv?.startTimeZone,
    endTimeZone: origMasterEv?.endTimeZone,
    ...eventData
  };
  const targetRid = eventData?.recurrenceId || (eventData?.uid && eventData.uid.includes('::') ? eventData.uid.split('::')[1] : null);
  // Saved from a detached override: the modal was filled from the override, so
  // a field still equal to the override's value was not edited and keeps the
  // master's value instead of being promoted onto every occurrence (#242).
  const override = targetRid && origMasterEv ? parseICSToEvent(existingIcs, { recurrenceId: targetRid }) : null;
  if (override) {
    for (const [field, key] of Object.entries(SERIES_FIELD_KEYS)) {
      if (key(eventData[field]) === key(override[field])) {
        masterEventData[field] = origMasterEv[field];
      }
    }
  }
  if (targetRid && master.getFirstProperty('rrule')) {
    if (origMasterEv && origMasterEv.start) {
      const incStartMs = new Date(eventData.start).getTime();
      if (!isNaN(incStartMs)) {
        let ridMs = null;
        const t = occurrenceTime(master, targetRid);
        if (t) ridMs = t.toJSDate().getTime();
        if (!ridMs && !isNaN(new Date(targetRid).getTime())) {
          ridMs = new Date(targetRid).getTime();
        }
        const minMs = ridMs ? Math.min(incStartMs, ridMs) : incStartMs;
        const maxMs = ridMs ? Math.max(incStartMs, ridMs) : incStartMs;
        const searchStart = new Date(minMs - 48 * 3600 * 1000).toISOString();
        const searchEnd   = new Date(maxMs + 48 * 3600 * 1000).toISOString();
        const expanded = parseAndExpandEvent(existingIcs, searchStart, searchEnd);
        let origOcc = expanded.find(e => ridsMatch(e.recurrenceId, targetRid));
        if (!origOcc) {
          origOcc = expanded.find(e => new Date(e.start).getTime() === incStartMs);
        }
        const origOccStartMs = origOcc && origOcc.start ? new Date(origOcc.start).getTime() : ridMs;
        if (origOccStartMs !== null && !isNaN(origOccStartMs)) {
          const timeDeltaMs = incStartMs - origOccStartMs;
          if (Math.abs(timeDeltaMs) <= 1000) {
            masterEventData = {
              ...masterEventData,
              uid: origMasterEv.uid || (eventData.uid ? eventData.uid.split('::')[0] : eventData.uid),
              start: origMasterEv.start,
              end: origMasterEv.end
            };
          } else {
            const newMasterStartMs = new Date(origMasterEv.start).getTime() + timeDeltaMs;
            const newMasterStartIso = new Date(newMasterStartMs).toISOString();

            let newMasterEndIso = null;
            if (eventData.end && eventData.start) {
              let durationMs = new Date(eventData.end).getTime() - incStartMs;
              // The override's own length was echoed back, not chosen (#242).
              if (override && override.start && override.end && origMasterEv.end
                  && durationMs === new Date(override.end).getTime() - new Date(override.start).getTime()) {
                durationMs = new Date(origMasterEv.end).getTime() - new Date(origMasterEv.start).getTime();
              }
              newMasterEndIso = new Date(newMasterStartMs + durationMs).toISOString();
            }

            const shiftedRecurrence = normalizeRecurrenceRule(
              eventData.recurrence || origMasterEv?.recurrence || masterEventData.recurrence,
              newMasterStartIso,
              masterEventData.allDay ? null : masterEventData.startTimeZone
            );

            masterEventData = {
              ...masterEventData,
              uid: origMasterEv.uid || (eventData.uid ? eventData.uid.split('::')[0] : eventData.uid),
              start: newMasterStartIso,
              end: newMasterEndIso || eventData.end,
              ...(shiftedRecurrence ? { recurrence: shiftedRecurrence } : {})
            };
          }
          delete masterEventData.recurrenceId;
        }
      }
    }
  }

  if (masterEventData.recurrence && masterEventData.start) {
    masterEventData.recurrence = normalizeRecurrenceRule(masterEventData.recurrence, masterEventData.start, masterEventData.allDay ? null : masterEventData.startTimeZone);
  } else if (!masterEventData.recurrence && origMasterEv?.recurrence && masterEventData.start) {
    masterEventData.recurrence = normalizeRecurrenceRule(origMasterEv.recurrence, masterEventData.start, masterEventData.allDay ? null : masterEventData.startTimeZone);
  }

  const newMasterIcs = eventToICS(masterEventData, existingIcs);
  let newMasterComp;
  try {
    newMasterComp = new ICAL.Component(ICAL.parse(newMasterIcs));
  } catch (e) {
    return eventToICS(eventData);
  }

  const newMaster = newMasterComp.getAllSubcomponents('vevent').find(v => !v.getFirstProperty('recurrence-id')) || newMasterComp.getFirstSubcomponent('vevent');
  if (!newMaster) {
    return eventToICS(eventData);
  }

  // Ensure single weekly BYDAY matches newMaster's dtstart
  const rruleProp = newMaster.getFirstProperty('rrule');
  const dtstartProp = newMaster.getFirstProperty('dtstart');
  if (rruleProp && dtstartProp) {
    const dtstartTime = dtstartProp.getFirstValue();
    const currRruleVal = rruleProp.getFirstValue();
    const currRruleStr = currRruleVal ? currRruleVal.toString() : rruleProp.toICALString();
    let normRrule = normalizeRecurrenceRule(currRruleStr, dtstartTime);
    const baseRecurrence = (eventData && eventData.recurrence) || (origRrule ? origRrule.toString() : null);
    const baseByday = _singleWeeklyByday(baseRecurrence);
    if (offPatternByday && baseByday && _singleWeeklyByday(currRruleStr)) {
      // Off-pattern rule: a BYDAY the client changed (the modal re-syncs it on a
      // date move) is taken as given; the stored one is shifted only by as many
      // weekdays as this save moved DTSTART.
      const dayShift = (dtstartTime.dayOfWeek() - origDtstartTime.dayOfWeek() + 7) % 7;
      const targetByday = baseByday === origByday
        ? WEEKDAY_NAMES[(WEEKDAY_NAMES.indexOf(baseByday) + dayShift) % 7]
        : baseByday;
      normRrule = currRruleStr.replace(/(^|;)BYDAY=[^;]+/i, `$1BYDAY=${targetByday}`);
    }
    if (normRrule && normRrule !== currRruleStr) {
      try {
        rruleProp.setValue(ICAL.Recur.fromString(normRrule.replace(/^RRULE:/i, '').trim()));
      } catch (_) {
        rruleProp.setValue(normRrule);
      }
    }
  }

  const existingExdateIcs = new Set(newMaster.getAllProperties('exdate').map(p => p.toICALString()));
  for (const exProp of exdateProps) {
    if (!existingExdateIcs.has(exProp.toICALString())) {
      newMaster.addProperty(exProp);
    }
  }

  comp.removeSubcomponent(master);
  _reconcileSeriesExceptions(comp, master, newMaster);
  comp.addSubcomponent(newMaster);

  const newTzs = newMasterComp.getAllSubcomponents('vtimezone');
  for (const tz of newTzs) {
    const tzid = tz.getFirstPropertyValue('tzid');
    const existingTzs = comp.getAllSubcomponents('vtimezone');
    if (!existingTzs.some(t => t.getFirstPropertyValue('tzid') === tzid)) {
      comp.addSubcomponent(tz);
    }
  }

  return cleanMalformedTzidZ(comp.toString());
}

module.exports = {
  parseTriggerOffsetMs,
  calculateAlarmTime,
  parseValarms,
  alarmTriggerLine,
  assertValidAlarms,
  parseVEventToEvent,
  parseICSToEvent,
  parseAndExpandEvent,
  expandCalendarInRange,
  eventToICS,
  escIcal,
  escParamVal,
  buildVTimezoneBlock,
  isValidTimezone,
  getUtcDate,
  isTzidLossy,
  isNoOpEventSave,
  addOccurrenceException,
  upsertOccurrenceOverride,
  cloneOccurrenceOverride,
  updateWholeSeries,
  normalizeRecurrenceRule,
  foldLines
};

