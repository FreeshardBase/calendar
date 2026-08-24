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
    if (!url) continue;
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
    attachments,
    categories,
    calendarId:  meta.calendarId  || null,
    accountId:   meta.accountId   || null,
    href:        meta.href        || null,
    etag:        meta.etag        || null
  };
}

function parseICSToEvent(icsString, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp  = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) return null;

  let vevent;
  const targetRid = (meta.recurrenceId || meta.recurrence_id || '').toString();
  if (targetRid) {
    const normTarget = targetRid.replace(/[-:]/g, '').toUpperCase();
    vevent = vevents.find(v => {
      const rid = v.getFirstPropertyValue('recurrence-id');
      if (!rid) return false;
      const str = rid.toICALString ? rid.toICALString() : rid.toString();
      const normStr = str.replace(/[-:]/g, '').toUpperCase();
      return normStr === normTarget;
    });
  } else {
    vevent = vevents.find(v => !v.getFirstProperty('recurrence-id'));
  }

  if (!vevent && !targetRid) {
    vevent = vevents[0];
  }

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

  // Collect unique TZID values that need VTIMEZONE blocks (non-allDay only)
  const tzids = [];
  if (!event.allDay) {
    if (event.startTimeZone && !tzids.includes(event.startTimeZone)) {
      tzids.push(event.startTimeZone);
    }
    if (event.endTimeZone && !tzids.includes(event.endTimeZone)) {
      tzids.push(event.endTimeZone);
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
    lines.push(block);
    _registerVTimezoneBlock(tzid, block);
  }

  lines.push(
    'BEGIN:VEVENT',
    `UID:${String(uid).replace(/[\r\n]/g, '')}`,
    `DTSTAMP:${dtstamp}`,
    `LAST-MODIFIED:${dtstamp}`,
    `SUMMARY:${escIcal(event.title || 'Untitled')}`
  );

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtDate(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtDate(event.end)}`);
  } else {
    if (event.startTimeZone) {
      lines.push(`DTSTART;TZID=${escParamVal(event.startTimeZone)}:${fmtDateTimeTzid(event.start, event.startTimeZone)}`);
    } else {
      lines.push(`DTSTART:${fmtDateTime(event.start)}`);
    }

    if (event.endTimeZone) {
      lines.push(`DTEND;TZID=${escParamVal(event.endTimeZone)}:${fmtDateTimeTzid(event.end, event.endTimeZone)}`);
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
    const cn      = att.name   ? `;CN="${escParamVal(att.name)}"`           : '';
    const partstat = `;PARTSTAT=${escParamVal(att.status || 'NEEDS-ACTION')}`;
    lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL${cn}${partstat};RSVP=TRUE:mailto:${String(att.email).replace(/[\r\n]/g, '')}`);
  }

  if (event.recurrence) lines.push(`RRULE:${String(event.recurrence).replace(/[\r\n]/g, '')}`);

  const alarms = Array.isArray(event.alarms) ? event.alarms : (event.valarm ? [event.valarm] : []);
  for (const alarm of alarms) {
    lines.push('BEGIN:VALARM');
    lines.push(`ACTION:${String(alarm.action || 'DISPLAY').replace(/[\r\n]/g, '')}`);
    lines.push(`TRIGGER:${String(alarm.trigger || '-PT15M').replace(/[\r\n]/g, '')}`);
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

function escParamVal(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/["\r\n]/g, '')
    .replace(/\\/g, '\\\\');
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
  } catch {
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
 * @returns {string} Multi-line VTIMEZONE block (lines joined with \r\n)
 */
function buildVTimezoneBlock(tzid) {
  // Reference dates: northern-hemisphere winter and summer
  const winterDate = new Date('2026-01-15T12:00:00Z');
  const summerDate = new Date('2026-07-15T12:00:00Z');

  const winterOffset = _tzOffsetMinutes(tzid, winterDate);
  const summerOffset = _tzOffsetMinutes(tzid, summerDate);

  const hasDST = (winterOffset !== summerOffset);

  // For most northern-hemisphere zones, summer has higher offset (DST ahead)
  const stdOffset = hasDST ? Math.min(winterOffset, summerOffset) : winterOffset;
  const dstOffset = hasDST ? Math.max(winterOffset, summerOffset) : winterOffset;

  const lines = [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`
  ];

  // STANDARD sub-component (winter / no-DST)
  lines.push('BEGIN:STANDARD');
  lines.push('DTSTART:19701025T030000');
  lines.push('RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10');
  lines.push(`TZOFFSETFROM:${_fmtOffset(dstOffset)}`);
  lines.push(`TZOFFSETTO:${_fmtOffset(stdOffset)}`);
  lines.push('END:STANDARD');

  // DAYLIGHT sub-component (summer, only if zone observes DST)
  if (hasDST) {
    lines.push('BEGIN:DAYLIGHT');
    lines.push('DTSTART:19700329T020000');
    lines.push('RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3');
    lines.push(`TZOFFSETFROM:${_fmtOffset(stdOffset)}`);
    lines.push(`TZOFFSETTO:${_fmtOffset(dstOffset)}`);
    lines.push('END:DAYLIGHT');
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
  }
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

  let stored;
  try {
    const targetRecurrenceId = recurrenceId || incomingEventData?.recurrenceId;
    stored = parseICSToEvent(existingIcs, { recurrenceId: targetRecurrenceId });
  } catch (_) {
    return false;
  }

  if (!stored) return false;

  const incoming = incomingEventData || {};

  // ── Title ────────────────────────────────────────────────────────────────
  const storedTitle    = (stored.title    || '').trim();
  const incomingTitle  = (incoming.title  || '').trim();
  if (storedTitle !== incomingTitle) return false;

  // ── Start / End (compare UTC instants; null == null is ok) ───────────────
  const toUtcMs = (v) => {
    if (!v) return null;
    const ms = new Date(v).getTime();
    return isNaN(ms) ? null : ms;
  };

  if (toUtcMs(stored.start) !== toUtcMs(incoming.start)) return false;
  if (toUtcMs(stored.end)   !== toUtcMs(incoming.end))   return false;

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
  const alarmKey = (a) => `${(a.action || '').toUpperCase()}:${(a.trigger || '').trim()}`;
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
  } catch (e) {
    return eventToICS(eventData);
  }

  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) {
    return eventToICS(eventData);
  }

  const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
  const exdateProps = master.getAllProperties('exdate');

  const newMasterIcs = eventToICS(eventData);
  let newMasterComp;
  try {
    newMasterComp = new ICAL.Component(ICAL.parse(newMasterIcs));
  } catch (e) {
    return eventToICS(eventData);
  }

  const newMaster = newMasterComp.getFirstSubcomponent('vevent');
  if (!newMaster) {
    return eventToICS(eventData);
  }

  for (const exProp of exdateProps) {
    newMaster.addProperty(exProp);
  }

  comp.removeSubcomponent(master);
  comp.addSubcomponent(newMaster);

  const newTzs = newMasterComp.getAllSubcomponents('vtimezone');
  for (const tz of newTzs) {
    const tzid = tz.getFirstPropertyValue('tzid');
    const existingTzs = comp.getAllSubcomponents('vtimezone');
    if (!existingTzs.some(t => t.getFirstPropertyValue('tzid') === tzid)) {
      comp.addSubcomponent(tz);
    }
  }

  return comp.toString();
}

module.exports = {
  parseTriggerOffsetMs,
  calculateAlarmTime,
  parseValarms,
  parseVEventToEvent,
  parseICSToEvent,
  parseAndExpandEvent,
  eventToICS,
  escIcal,
  escParamVal,
  buildVTimezoneBlock,
  isNoOpEventSave,
  addOccurrenceException,
  upsertOccurrenceOverride,
  updateWholeSeries
};

