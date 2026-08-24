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
const {
  parseTriggerOffsetMs,
  calculateAlarmTime,
  parseValarms,
  parseVEventToEvent,
  parseICSToEvent,
  parseAndExpandEvent,
  eventToICS,
  isNoOpEventSave,
  addOccurrenceException,
  upsertOccurrenceOverride,
  updateWholeSeries
} = require('../utils/ical');

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

function parseICSToTask(icsString, meta = {}) {
  const jcal = ICAL.parse(icsString);
  const comp  = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  if (!vtodo) return null;
  return parseVTodoToTask(vtodo, meta);
}

function parseVTodoToTask(vtodo, meta = {}) {
  const uid = vtodo.getFirstPropertyValue('uid');
  const title = vtodo.getFirstPropertyValue('summary') || '(No title)';
  const description = vtodo.getFirstPropertyValue('description') || null;
  const status = (vtodo.getFirstPropertyValue('status') || 'NEEDS-ACTION').toString().toUpperCase();

  const dueProp = vtodo.getFirstProperty('due');
  let due = null;
  if (dueProp) {
    const val = dueProp.getFirstValue();
    due = val ? val.toJSDate().toISOString() : null;
  }

  const dtstartProp = vtodo.getFirstProperty('dtstart');
  let dtstart = null;
  if (dtstartProp) {
    const val = dtstartProp.getFirstValue();
    dtstart = val ? val.toJSDate().toISOString() : null;
  }

  const completedProp = vtodo.getFirstProperty('completed');
  let completed = null;
  if (completedProp) {
    const val = completedProp.getFirstValue();
    completed = val ? val.toJSDate().toISOString() : null;
  }

  const prioVal = vtodo.getFirstPropertyValue('priority');
  const priority = (prioVal !== null && prioVal !== undefined) ? parseInt(prioVal, 10) : null;

  const pctVal = vtodo.getFirstPropertyValue('percent-complete');
  const percentComplete = (pctVal !== null && pctVal !== undefined) ? parseInt(pctVal, 10) : null;

  let recurrence = null;
  const rrule = vtodo.getFirstProperty('rrule');
  if (rrule) recurrence = rrule.getFirstValue().toString();

  return {
    uid,
    title,
    description,
    status,
    due,
    dtstart,
    completed,
    priority,
    percentComplete,
    recurrence,
    calendarId: meta.calendarId || null,
    accountId:  meta.accountId  || null,
    href:       meta.href       || null,
    etag:       meta.etag       || null
  };
}

function parseTaskList(xml, calendarId, accountId, calendarUrl) {
  let doc;
  try {
    doc = xmlParser.parseFromString(xml, 'text/xml');
  } catch (e) {
    console.error('[parser] XML parse error:', e.message);
    return [];
  }

  const responses = getByLocalName(doc, 'response');
  const tasks = [];

  for (const response of responses) {
    const href = firstText(response, 'href');
    if (!href) continue;

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
      const task = parseICSToTask(calendarData, {
        calendarId,
        accountId,
        href,
        etag: etag ? etag.replace(/"/g, '') : null
      });
      if (task) tasks.push(task);
    } catch (e) {
      console.warn(`[parser] Failed to parse task ${href}:`, e.message);
    }
  }

  return tasks;
}

function taskToICS(task) {
  const uid     = task.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp = fmtDateTime(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `LAST-MODIFIED:${dtstamp}`,
    `SUMMARY:${escIcal(task.title || 'Untitled')}`
  ];

  if (task.description) lines.push(`DESCRIPTION:${escIcal(task.description)}`);
  if (task.status)      lines.push(`STATUS:${task.status}`);

  if (task.due) {
    lines.push(`DUE:${fmtDateTime(task.due)}`);
  }
  if (task.dtstart) {
    lines.push(`DTSTART:${fmtDateTime(task.dtstart)}`);
  }
  if (task.completed) {
    lines.push(`COMPLETED:${fmtDateTime(task.completed)}`);
  }
  if (task.priority !== null && task.priority !== undefined) {
    lines.push(`PRIORITY:${task.priority}`);
  }
  if (task.percentComplete !== null && task.percentComplete !== undefined) {
    lines.push(`PERCENT-COMPLETE:${task.percentComplete}`);
  }
  if (task.recurrence) {
    lines.push(`RRULE:${task.recurrence}`);
  }

  lines.push('END:VTODO', 'END:VCALENDAR');

  return foldLines(lines.join('\n')) + '\r\n';
}

function advanceRecurringTask(task) {
  if (!task || !task.recurrence) return task;

  const rrule = String(task.recurrence).toUpperCase();
  let baseDate = task.due ? new Date(task.due) : new Date();
  if (isNaN(baseDate.getTime())) baseDate = new Date();

  let interval = 1;
  const matchInterval = rrule.match(/INTERVAL=(\d+)/);
  if (matchInterval) {
    interval = parseInt(matchInterval[1], 10) || 1;
  }

  const nextDate = new Date(baseDate.getTime());
  if (rrule.includes('FREQ=DAILY')) {
    nextDate.setDate(nextDate.getDate() + interval);
  } else if (rrule.includes('FREQ=WEEKLY')) {
    nextDate.setDate(nextDate.getDate() + (7 * interval));
  } else if (rrule.includes('FREQ=MONTHLY')) {
    nextDate.setMonth(nextDate.getMonth() + interval);
  } else if (rrule.includes('FREQ=YEARLY')) {
    nextDate.setFullYear(nextDate.getFullYear() + interval);
  } else {
    nextDate.setDate(nextDate.getDate() + 1);
  }

  return {
    ...task,
    due: nextDate.toISOString(),
    status: 'NEEDS-ACTION',
    completed: null,
    percentComplete: 0
  };
}

function updateAttendeePartstat(icsString, attendeeEmail, status) {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) return icsString;

  const targetEmail = (attendeeEmail || '').toLowerCase().replace(/^mailto:/i, '');
  const newPartstat = (status || 'NEEDS-ACTION').toUpperCase();

  for (const vevent of vevents) {
    const attendees = vevent.getAllProperties('attendee');
    let found = false;
    for (const prop of attendees) {
      const val = prop.getFirstValue();
      const email = (typeof val === 'string' ? val : '').toLowerCase().replace(/^mailto:/i, '');
      if (email === targetEmail) {
        prop.setParameter('partstat', newPartstat);
        found = true;
      }
    }
    if (!found && targetEmail) {
      const newProp = new ICAL.Property('attendee');
      newProp.setValue(`mailto:${targetEmail}`);
      newProp.setParameter('partstat', newPartstat);
      newProp.setParameter('cutype', 'INDIVIDUAL');
      newProp.setParameter('rsvp', 'TRUE');
      vevent.addProperty(newProp);
    }
  }

  return comp.toString();
}

function buildItipReply(event, attendeeEmail, status) {
  const uid = event.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp = fmtDateTime(new Date().toISOString());
  const partstat = (status || 'ACCEPTED').toUpperCase();
  const email = (attendeeEmail || '').replace(/^mailto:/i, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar iTIP//EN',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escIcal(event.title || 'Event Reply')}`
  ];

  if (event.start) lines.push(`DTSTART:${fmtDateTime(event.start)}`);
  if (event.end) lines.push(`DTEND:${fmtDateTime(event.end)}`);

  if (event.organizer?.email) {
    const cn = event.organizer.name ? `;CN="${event.organizer.name}"` : '';
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }

  const att = (event.attendees || []).find(a => a.email?.toLowerCase() === email.toLowerCase());
  const cn = (att && att.name) ? `;CN="${att.name}"` : '';
  lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL${cn};PARTSTAT=${partstat}:mailto:${email}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return foldLines(lines.join('\n')) + '\r\n';
}

module.exports = {
  parseCalendarList,
  parseEventList,
  parseEventDataList,
  parseICSToEvent,
  parseAndExpandEvent,
  addOccurrenceException,
  upsertOccurrenceOverride,
  eventToICS,
  parseICSToTask,
  parseVTodoToTask,
  parseTaskList,
  taskToICS,
  advanceRecurringTask,
  updateAttendeePartstat,
  buildItipReply
};

/**
 * Parse RFC 6578 sync-collection REPORT response.
 */
function parseSyncCollectionResponse(xml, calendarId, accountId, calendarUrl, rangeStart, rangeEnd) {
  let doc;
  try {
    doc = xmlParser.parseFromString(xml, 'text/xml');
  } catch (e) {
    console.error('[parser] XML parse error:', e.message);
    return { syncToken: null, updated: [], deleted: [] };
  }

  const syncToken = firstText(doc, 'sync-token');
  const responses = getByLocalName(doc, 'response');
  const updated = [];
  const deleted = [];

  for (const response of responses) {
    const href = firstText(response, 'href');
    if (!href) continue;

    let is404 = false;
    const topStatus = firstText(response, 'status') || '';
    if (topStatus.includes('404') || topStatus.includes('410')) {
      is404 = true;
    }

    if (is404) {
      deleted.push(href);
      continue;
    }

    const propstats = getByLocalName(response, 'propstat');
    let calendarData = null;
    let etag = null;

    for (const ps of propstats) {
      const status = firstText(ps, 'status') || '';
      if (status.includes('404') || status.includes('410')) {
        is404 = true;
        break;
      }
      if (status.includes('200')) {
        calendarData = firstText(ps, 'calendar-data');
        etag = firstText(ps, 'getetag');
      }
    }

    if (is404) {
      deleted.push(href);
      continue;
    }

    if (calendarData) {
      try {
        const parsed = parseICSToEvent(calendarData, {
          calendarId,
          accountId,
          href,
          etag: etag ? etag.replace(/"/g, '') : null
        });
        if (parsed) {
          updated.push(parsed);
        }
      } catch (e) {
        console.warn(`[parser] Failed to parse delta event ${href}:`, e.message);
      }
    }
  }

  return { syncToken: syncToken || null, updated, deleted };
}

module.exports = {
  parseCalendarList,
  parseEventList,
  parseEventDataList,
  parseICSToEvent,
  parseAndExpandEvent,
  addOccurrenceException,
  upsertOccurrenceOverride,
  eventToICS,
  parseICSToTask,
  parseVTodoToTask,
  parseTaskList,
  taskToICS,
  advanceRecurringTask,
  updateAttendeePartstat,
  buildItipReply,
  parseSyncCollectionResponse,
  isNoOpEventSave,
  updateWholeSeries
};


