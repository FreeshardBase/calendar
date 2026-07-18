'use strict';

/**
 * CalDAV / iCalendar parser.
 *
 * XML parsing: @xmldom/xmldom — proper namespace-aware DOM in Node.js
 * iCal parsing: ical.js (Mozilla) — RFC 5545 compliant, handles RRULE, TZID etc.
 */

const { DOMParser } = require('@xmldom/xmldom');
const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');

const xmlParser = new DOMParser({
  // Suppress non-fatal xmldom warnings in production
  onError: () => {},
  onWarning: () => {}
});

// ── XML Helpers ───────────────────────────────────────────────────────────────

/**
 * Return all descendant elements matching the given local name (ignores namespace prefix).
 */
function getByLocalName(node, localName) {
  if (!node) return [];
  const result = [];
  // getElementsByTagNameNS with '*' wildcard namespace
  const nl = node.getElementsByTagNameNS('*', localName);
  for (let i = 0; i < nl.length; i++) result.push(nl[i]);
  return result;
}

function firstText(node, localName) {
  const els = getByLocalName(node, localName);
  return els.length > 0 ? (els[0].textContent || '').trim() : null;
}

// ── Calendar List Parser ──────────────────────────────────────────────────────

/**
 * Parse a PROPFIND Depth:1 response into an array of calendar objects.
 *
 * @param {string} xml       - Raw XML from CalDAV server
 * @param {string} accountId - Our internal account ID
 * @param {string} baseUrl   - Base URL of the CalDAV server (for resolving relative hrefs)
 */
function parseCalendarList(xml, accountId, baseUrl, username) {
  let doc;
  try {
    doc = xmlParser.parseFromString(xml, 'text/xml');
  } catch (e) {
    console.error('[parser] XML parse error:', e.message);
    return [];
  }

  const responses = getByLocalName(doc, 'response');
  const calendars = [];

  for (const response of responses) {
    const href = firstText(response, 'href');
    if (!href) continue;

    // Walk each propstat independently — look for the 200-OK one that has props
    const propstats = getByLocalName(response, 'propstat');
    let isCalendar   = false;
    let displayName  = null;
    let color        = null;
    let ctag         = null;
    let syncToken    = null;
    let supportsVEVENT = true;
    let ownerHref    = null;
    let shareAccess  = null;

    for (const ps of propstats) {
      const statusText = firstText(ps, 'status') || '';
      if (!statusText.includes('200')) continue;

      const prop = getByLocalName(ps, 'prop')[0];
      if (!prop) continue;

      // Check for <cal:calendar/> in resourcetype
      const calendarEls = getByLocalName(prop, 'calendar');
      if (calendarEls.length > 0) isCalendar = true;

      const dn = firstText(prop, 'displayname');
      if (dn) displayName = dn;

      const c = firstText(prop, 'calendar-color');
      if (c) color = c;

      const ct = firstText(prop, 'getctag');
      if (ct) ctag = ct;

      const st = firstText(prop, 'sync-token');
      if (st) syncToken = st;

      const ownerEl = getByLocalName(prop, 'owner')[0];
      if (ownerEl) {
        ownerHref = firstText(ownerEl, 'href');
      }

      const shareAccessEl = getByLocalName(prop, 'share-access')[0];
      if (shareAccessEl) {
        if (getByLocalName(shareAccessEl, 'read-write').length > 0) {
          shareAccess = 'read-write';
        } else if (getByLocalName(shareAccessEl, 'read').length > 0) {
          shareAccess = 'read';
        } else if (getByLocalName(shareAccessEl, 'shared-owner').length > 0) {
          shareAccess = 'shared-owner';
        } else if (getByLocalName(shareAccessEl, 'not-shared').length > 0) {
          shareAccess = 'not-shared';
        }
      }

      // Check supported-calendar-component-set
      const compSets = getByLocalName(prop, 'supported-calendar-component-set');
      if (compSets.length > 0) {
        // Components are listed as <comp name="VEVENT"/> child elements (attribute-based)
        const compEls = getByLocalName(compSets[0], 'comp');
        if (compEls.length > 0) {
          supportsVEVENT = [...compEls].some(
            el => (el.getAttribute('name') || '').toUpperCase() === 'VEVENT'
          );
        }
        // If compEls is empty, fall back to textContent (some servers list as text)
        if (compEls.length === 0) {
          supportsVEVENT = compSets[0].textContent.includes('VEVENT');
        }
      }
    }

    if (!isCalendar) continue;
    if (!supportsVEVENT) continue;

    const url = href.startsWith('http')
      ? href
      : resolveUrl(baseUrl, href);

    let isShared = false;
    let ownerName = null;
    let readOnly = false;

    if (ownerHref && username) {
      const cleanOwnerHref = ownerHref.replace(/\/$/, '');
      const segments = cleanOwnerHref.split('/');
      const ownerUsername = segments[segments.length - 1];
      if (ownerUsername && ownerUsername.toLowerCase() !== username.toLowerCase()) {
        isShared = true;
        ownerName = ownerUsername;
        readOnly = (shareAccess !== 'read-write');
      }
    }

    calendars.push({
      id: `${accountId}::${href}`,
      accountId,
      href,
      url,
      name: displayName || 'Calendar',
      color: normaliseColor(color || ''),
      ctag,
      syncToken,
      isShared,
      owner: ownerName,
      readOnly
    });
  }

  return calendars;
}

// ── Event List Parser ─────────────────────────────────────────────────────────

/**
 * Parse a REPORT (calendar-query) response into an array of event objects.
 *
 * @param {string} xml
 * @param {string} calendarId
 * @param {string} accountId
 * @param {string} calendarUrl
 */
function parseEventList(xml, calendarId, accountId, calendarUrl, rangeStart, rangeEnd) {
  let doc;
  try {
    doc = xmlParser.parseFromString(xml, 'text/xml');
  } catch (e) {
    console.error('[parser] XML parse error:', e.message);
    return [];
  }

  const responses = getByLocalName(doc, 'response');
  const events = [];

  for (const response of responses) {
    const href = firstText(response, 'href');
    if (!href || !href.endsWith('.ics')) continue;

    // Find the 200-OK propstat
    const propstats = getByLocalName(response, 'propstat');
    let calendarData = null;
    let etag = null;

    for (const ps of propstats) {
      const status = firstText(ps, 'status') || '';
      if (status.includes('200')) {
        calendarData = firstText(ps, 'calendar-data');
        etag = firstText(ps, 'getetag');
        break;
      }
    }

    if (!calendarData) continue;

    try {
      const instances = parseAndExpandEvent(calendarData, rangeStart, rangeEnd, {
        calendarId,
        accountId,
        href,
        etag: etag ? etag.replace(/"/g, '') : null
      });
      events.push(...instances);
    } catch (e) {
      console.warn(`[parser] Failed to parse/expand event ${href}:`, e.message);
    }
  }

  return events;
}

/**
 * Extract the raw iCalendar payloads (calendar-data) from a REPORT response.
 * Returns one ICS string per event resource, unmodified — recurrence rules,
 * timezones etc. stay intact (unlike parseEventList, which expands instances).
 */
function parseEventDataList(xml) {
  let doc;
  try {
    doc = xmlParser.parseFromString(xml, 'text/xml');
  } catch (e) {
    console.error('[parser] XML parse error:', e.message);
    return [];
  }

  return getByLocalName(doc, 'calendar-data')
    .map(el => (el.textContent || '').trim())
    .filter(Boolean);
}

function parseAndExpandEvent(icsString, rangeStart, rangeEnd, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return [];

  const event = parseICSToEvent(icsString, meta);
  if (!event) return [];

  // If there's no RRULE, it's a single non-recurring event
  const rrule = vevent.getFirstProperty('rrule');
  if (!rrule) {
    return [event];
  }

  // If we don't have range start/end specified, fallback to just returning the master event
  if (!rangeStart || !rangeEnd) {
    return [event];
  }

  const dtstart = vevent.getFirstPropertyValue('dtstart');
  const dtend = vevent.getFirstPropertyValue('dtend');
  
  let duration = 0;
  if (dtstart && dtend) {
    duration = dtend.toJSDate().getTime() - dtstart.toJSDate().getTime();
  }

  const limitStart = new Date(rangeStart);
  const limitEnd = new Date(rangeEnd);

  // Safety check: if dtstart is after limitEnd, it doesn't recur in this range
  if (dtstart.toJSDate() > limitEnd) {
    return [];
  }

  const expand = new ICAL.RecurExpansion({
    component: vevent,
    dtstart: dtstart
  });

  const instances = [];
  let next;
  let count = 0;
  const maxCount = 500; // safety limit to prevent infinite loops

  while ((next = expand.next()) && count < maxCount) {
    count++;
    const occStart = next.toJSDate();
    
    // Stop expanding if the occurrence starts after our query range end
    if (occStart.getTime() > limitEnd.getTime()) {
      break;
    }

    const occEnd = new Date(occStart.getTime() + duration);

    // Collect the occurrence if it overlaps with our query range
    if (occEnd.getTime() >= limitStart.getTime()) {
      const instanceUid = `${event.uid}::${next.toString()}`;
      instances.push({
        ...event,
        uid: instanceUid,
        masterUid: event.uid,
        start: occStart.toISOString(),
        end: occEnd.toISOString(),
        recurrenceId: next.toString()
      });
    }
  }

  return instances;
}

// ── iCalendar → JSON ──────────────────────────────────────────────────────────

function parseICSToEvent(icsString, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp  = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;

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

  // Recurrence rule (keep as string for now)
  let recurrence = null;
  const rrule = vevent.getFirstProperty('rrule');
  if (rrule) recurrence = rrule.getFirstValue().toString();

  // Timezone IDs
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
    calendarId:  meta.calendarId  || null,
    accountId:   meta.accountId   || null,
    href:        meta.href        || null,
    etag:        meta.etag        || null
  };
}

// ── JSON → iCalendar ──────────────────────────────────────────────────────────

function eventToICS(event) {
  const uid      = event.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp  = fmtDateTime(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    // NOTE: RFC 4791 §4.1 prohibits METHOD in CalDAV objects — do not add it
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

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // Join with \n, then foldLines handles CRLF conversion
  return foldLines(lines.join('\n')) + '\r\n';
}

// ── Utility Functions ─────────────────────────────────────────────────────────

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

/** RFC 5545 line folding: max 75 octets per line, CRLF line endings. */
function foldLines(text) {
  return text.split('\n').map(line => {
    // Normalise any existing \r
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

/** Normalise calendar color: strip alpha (#RRGGBBAA → #RRGGBB), fall back to indigo. */
function normaliseColor(raw) {
  const c = (raw || '').trim();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{3}$/.test(c)) return c;
  return '#6366f1';
}

function resolveUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return base.replace(/\/+$/, '') + '/' + href.replace(/^\/+/, '');
  }
}

module.exports = {
  parseCalendarList,
  parseEventList,
  parseEventDataList,
  parseICSToEvent,
  parseAndExpandEvent,
  eventToICS
};
