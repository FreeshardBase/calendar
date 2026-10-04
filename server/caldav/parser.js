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
  escParamVal,
  isNoOpEventSave,
  addOccurrenceException,
  upsertOccurrenceOverride,
  updateWholeSeries,
  normalizeRecurrenceRule
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
    let supportsVTODO  = true;
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
        // Components are listed as <comp name="VEVENT"/> child elements or text/custom elements
        let compEls = getByLocalName(compSets[0], 'comp');
        if (compEls.length === 0 && compSets[0].childNodes) {
          compEls = Array.from(compSets[0].childNodes).filter(el => el.nodeType === 1);
        }
        if (compEls.length > 0) {
          const compNames = compEls.map(
            el => (el.getAttribute('name') || el.textContent || '').toUpperCase()
          );
          supportsVEVENT = compNames.includes('VEVENT');
          supportsVTODO = compNames.includes('VTODO');
        } else {
          const text = (compSets[0].textContent || '') + ' ' + (compSets[0].toString ? compSets[0].toString() : '');
          supportsVEVENT = text.includes('VEVENT');
          supportsVTODO = text.includes('VTODO');
        }
      }
    }

    if (!isCalendar) continue;
    if (!supportsVEVENT && !supportsVTODO) continue;

    const url = resolveUrl(baseUrl, href);

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
      readOnly,
      supportsVEVENT,
      supportsVTODO
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
        etag: etag ? etag.trim() : null
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
  if (typeof iso === 'string' && /^\d{8}T\d{6}Z?$/.test(iso)) {
    return iso.endsWith('Z') ? iso : iso + 'Z';
  }
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function fmtDateTimeTzid(iso, tzid) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return null;
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
  if (!iso) return null;
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso.slice(0, 10))) {
    const parts = iso.slice(0, 10).split('-');
    const dt = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    if (!isNaN(dt.getTime())) {
      return iso.slice(0, 10).replace(/-/g, '');
    }
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** RFC 5545 line folding: max 75 octets per line, CRLF line endings. */
function foldLines(text) {
  return text.split('\n').map(line => {
    // Normalise any existing \r
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

/** Normalise calendar color: strip alpha (#RRGGBBAA → #RRGGBB), fall back to indigo. */
function normaliseColor(raw) {
  const c = (raw || '').trim();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{3}$/.test(c)) return c;
  return '#6366f1';
}

function resolveUrl(base, href) {
  if (!href) return base || '';
  if (!base) return href;
  try {
    const baseUrl = new URL(base);
    const resolved = new URL(href, base);
    resolved.protocol = baseUrl.protocol;
    resolved.hostname = baseUrl.hostname;
    resolved.port = baseUrl.port;
    return resolved.href;
  } catch {
    const cleanHref = String(href).replace(/^(\\\\|[a-z0-9+-.]+:\/\/|\/\/)[^/]+/i, '');
    try {
      return new URL(cleanHref, base).href;
    } catch {
      return (base || '').replace(/\/+$/, '') + '/' + cleanHref.replace(/^\/+/, '');
    }
  }
}

/**
 * Issue #94 — Reconcile STATUS, COMPLETED date, and PERCENT-COMPLETE properties on VTODO.
 * Enforces mutual consistency across all 3 fields:
 * - STATUS:COMPLETED <-> PERCENT-COMPLETE:100 <-> COMPLETED:<ISO string>
 * - STATUS:NEEDS-ACTION/IN-PROCESS/etc <-> COMPLETED:null (removed) <-> PERCENT-COMPLETE != 100
 */
function reconcileTaskStatus(task) {
  if (!task || typeof task !== 'object') return task;

  const res = { ...task };

  let status = res.status ? String(res.status).replace(/[\r\n\x00-\x1f]/g, '').trim().toUpperCase() : null;
  const validStatuses = new Set(['NEEDS-ACTION', 'COMPLETED', 'IN-PROCESS', 'CANCELLED']);
  if (status && !validStatuses.has(status) && !/^[A-Z0-9-]+$/.test(status)) {
    status = null;
  }
  let completed = res.completed || null;
  let percentComplete = (res.percentComplete !== null && res.percentComplete !== undefined)
    ? parseInt(res.percentComplete, 10)
    : ((res['percent-complete'] !== null && res['percent-complete'] !== undefined)
      ? parseInt(res['percent-complete'], 10)
      : null);

  if (status === 'COMPLETED') {
    if (percentComplete !== null && percentComplete < 100) {
      status = percentComplete > 0 ? 'IN-PROCESS' : 'NEEDS-ACTION';
      completed = null;
    } else {
      status = 'COMPLETED';
      completed = completed || new Date().toISOString();
      percentComplete = 100;
    }
  } else if (status === 'IN-PROCESS') {
    completed = null;
    if (percentComplete === 100 || percentComplete === null) {
      percentComplete = 50;
    }
  } else if (status === 'NEEDS-ACTION') {
    completed = null;
    if (percentComplete === 100 || percentComplete === null) {
      percentComplete = 0;
    }
  } else if (status && status !== 'CANCELLED') {
    completed = null;
    if (percentComplete === 100) percentComplete = 0;
  } else if (percentComplete === 100) {
    status = 'COMPLETED';
    completed = completed || new Date().toISOString();
  } else if (percentComplete !== null && percentComplete > 0 && percentComplete < 100) {
    status = 'IN-PROCESS';
    completed = null;
  } else {
    status = status || 'NEEDS-ACTION';
    completed = null;
    if (percentComplete === 100) percentComplete = 0;
  }

  res.status = status;
  res.completed = completed;
  res.percentComplete = percentComplete;

  return res;
}

function parseICSToTask(icsString, meta = {}) {
  try {
    const jcal = ICAL.parse(icsString);
    const comp = new ICAL.Component(jcal);
    const vtimezones = comp.getAllSubcomponents ? comp.getAllSubcomponents('vtimezone') : [];
    for (const vtz of vtimezones) {
      try {
        const tzid = vtz.getFirstPropertyValue('tzid');
        if (tzid && !ICAL.TimezoneService.has(tzid)) {
          ICAL.TimezoneService.register(vtz);
        }
      } catch (_) {}
    }
    const vtodo = comp.getFirstSubcomponent('vtodo');
    if (!vtodo) return null;
    return parseVTodoToTask(vtodo, { rawIcs: icsString, ...meta });
  } catch (e) {
    console.warn('[parser] Failed to parse ICS string to task:', e.message);
    return null;
  }
}

function parseVTodoToTask(vtodo, meta = {}) {
  const rawIcs = meta.rawIcs || null;
  const uid = vtodo.getFirstPropertyValue('uid') || `${uuidv4()}@freeshard.webcalendar`;
  const summaryProp = vtodo.getFirstProperty('summary');
  const title = summaryProp ? summaryProp.getFirstValue() : 'Untitled';
  const descProp = vtodo.getFirstProperty('description');
  const description = descProp ? descProp.getFirstValue() : null;
  const statusProp = vtodo.getFirstProperty('status');
  const status = statusProp ? statusProp.getFirstValue() : 'NEEDS-ACTION';

  const dueProp = vtodo.getFirstProperty('due');
  let due = null;
  let dueIsDate = false;
  if (dueProp) {
    const val = dueProp.getFirstValue();
    if (val) {
      dueIsDate = !!val.isDate;
      if (val.isDate) {
        const y = String(val.year).padStart(4, '0');
        const m = String(val.month).padStart(2, '0');
        const d = String(val.day).padStart(2, '0');
        due = `${y}-${m}-${d}T00:00:00.000Z`;
      } else {
        due = val.toJSDate().toISOString();
      }
    }
  }

  const dtstartProp = vtodo.getFirstProperty('dtstart');
  let dtstart = null;
  let dtstartIsDate = false;
  if (dtstartProp) {
    const val = dtstartProp.getFirstValue();
    if (val) {
      dtstartIsDate = !!val.isDate;
      if (val.isDate) {
        const y = String(val.year).padStart(4, '0');
        const m = String(val.month).padStart(2, '0');
        const d = String(val.day).padStart(2, '0');
        dtstart = `${y}-${m}-${d}T00:00:00.000Z`;
      } else {
        dtstart = val.toJSDate().toISOString();
      }
    }
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

  const durationProp = vtodo.getFirstProperty('duration');
  let duration = null;
  if (durationProp) {
    const val = durationProp.getFirstValue();
    if (val) duration = val.toString();
  }

  if (!due && dtstart && durationProp) {
    try {
      const startVal = dtstartProp ? dtstartProp.getFirstValue() : null;
      const durVal = durationProp.getFirstValue();
      if (startVal && durVal) {
        const calculated = startVal.clone();
        calculated.addDuration(durVal);
        dueIsDate = !!calculated.isDate;
        if (calculated.isDate) {
          const y = String(calculated.year).padStart(4, '0');
          const m = String(calculated.month).padStart(2, '0');
          const d = String(calculated.day).padStart(2, '0');
          due = `${y}-${m}-${d}T00:00:00.000Z`;
        } else {
          due = calculated.toJSDate().toISOString();
        }
      }
    } catch (_) {}
  }

  let recurrence = null;
  const rrule = vtodo.getFirstProperty('rrule');
  if (rrule) recurrence = rrule.getFirstValue().toString();

  const categories = [];
  for (const prop of vtodo.getAllProperties('categories')) {
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

  const completedHistory = [];
  const compDatesProp = vtodo.getFirstProperty('x-completed-dates');
  if (compDatesProp) {
    const val = compDatesProp.getFirstValue();
    if (typeof val === 'string' && val.trim()) {
      val.split(',').forEach(d => { if (d.trim()) completedHistory.push(d.trim()); });
    }
  }

  return reconcileTaskStatus({
    uid,
    title,
    description,
    status,
    due,
    dueIsDate,
    dtstart,
    dtstartIsDate,
    duration,
    completed,
    priority,
    percentComplete,
    recurrence,
    categories,
    completedHistory,
    rawIcs: rawIcs || meta.rawIcs || null,
    calendarId: meta.calendarId || null,
    accountId:  meta.accountId  || null,
    href:       meta.href       || null,
    etag:       meta.etag       || null
  });
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
        etag: etag ? etag.trim() : null,
        rawIcs: calendarData
      });
      if (task) tasks.push(task);
    } catch (e) {
      console.warn(`[parser] Failed to parse task ${href}:`, e.message);
    }
  }

  return tasks;
}

function taskToICS(rawTask, existingIcs = null) {
  const task = reconcileTaskStatus(rawTask);
  const baseIcs = existingIcs || task.rawIcs || null;

  if (baseIcs && typeof baseIcs === 'string' && baseIcs.trim()) {
    try {
      const jcal = ICAL.parse(baseIcs);
      const comp = new ICAL.Component(jcal);
      const vtodo = comp.getFirstSubcomponent('vtodo');
      if (vtodo) {
        const uid = task.uid || vtodo.getFirstPropertyValue('uid') || `${uuidv4()}@freeshard.webcalendar`;

        const setProp = (name, val) => {
          if (val === null || val === undefined || val === '') {
            vtodo.removeAllProperties(name);
          } else {
            const prop = vtodo.getFirstProperty(name);
            if (prop) {
              prop.setValue(val);
            } else {
              vtodo.addPropertyWithValue(name, val);
            }
          }
        };

        const setDateProp = (name, isoVal, forceIsDate = undefined) => {
          if (!isoVal || (typeof isoVal === 'string' && isNaN(new Date(isoVal).getTime()))) {
            vtodo.removeAllProperties(name);
          } else {
            let timeVal;
            try {
              const existingProp = vtodo.getFirstProperty(name);
              const existingIsDate = existingProp && existingProp.getFirstValue() ? existingProp.getFirstValue().isDate : false;
              const isDate = forceIsDate === false
                ? false
                : (Boolean(forceIsDate) || existingIsDate || (typeof isoVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoVal)));

              const dt = new Date(isoVal);
              if (!isNaN(dt.getTime())) {
                if (isDate) {
                  timeVal = new ICAL.Time({
                    year: dt.getUTCFullYear(),
                    month: dt.getUTCMonth() + 1,
                    day: dt.getUTCDate(),
                    isDate: true
                  });
                } else {
                  timeVal = ICAL.Time.fromJSDate(dt, true);
                }
              }
            } catch (_) {}

            if (timeVal) {
              const prop = vtodo.getFirstProperty(name);
              if (prop) {
                prop.setValue(timeVal);
                if (!timeVal.isDate) prop.removeParameter('value');
              } else {
                vtodo.addPropertyWithValue(name, timeVal);
              }
            } else {
              vtodo.removeAllProperties(name);
            }
          }
        };

        setProp('uid', uid);
        setProp('summary', task.title || 'Untitled');
        if ('description' in task) {
          setProp('description', task.description);
        }

        if ('status' in task) {
          if (task.status) {
            const cleanStatus = String(task.status).replace(/[\r\n\x00-\x1f]/g, '').trim().toUpperCase();
            const validStatus = ['NEEDS-ACTION', 'COMPLETED', 'IN-PROCESS', 'CANCELLED'].includes(cleanStatus)
              ? cleanStatus
              : (/^[A-Z0-9-]+$/.test(cleanStatus) ? cleanStatus : 'NEEDS-ACTION');
            setProp('status', validStatus);
          } else {
            vtodo.removeAllProperties('status');
          }
        }

        const isValidDateVal = (val) => Boolean(val) && !isNaN(new Date(val).getTime());
        const isValidDurationVal = (val) => Boolean(val) && /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.test(String(val).trim());

        const hasDtstart = Boolean((task.dtstart && isValidDateVal(task.dtstart)) || (vtodo.getFirstProperty('dtstart') && vtodo.getFirstProperty('dtstart').getFirstValue()));

        if (!hasDtstart) {
          // RFC 5545 3.6.2: A VTODO without DTSTART MUST NOT have DURATION.
          vtodo.removeAllProperties('duration');
          if (task.due || 'due' in task) {
            setDateProp('due', task.due, task.dueIsDate !== undefined ? task.dueIsDate : (task.allDay !== undefined ? task.allDay : undefined));
          } else {
            vtodo.removeAllProperties('due');
          }
        } else {
          if (task.duration) {
            if (isValidDurationVal(task.duration)) {
              setProp('duration', String(task.duration).replace(/[\r\n]/g, '').trim());
              vtodo.removeAllProperties('due');
            } else {
              vtodo.removeAllProperties('duration');
            }
          } else if (task.due) {
            vtodo.removeAllProperties('duration');
            setDateProp('due', task.due, task.dueIsDate !== undefined ? task.dueIsDate : (task.allDay !== undefined ? task.allDay : undefined));
          } else {
            if ('duration' in task && !task.duration) vtodo.removeAllProperties('duration');
            if ('due' in task && !task.due) vtodo.removeAllProperties('due');
          }
        }
        if ('dtstart' in task) setDateProp('dtstart', task.dtstart, task.dtstartIsDate !== undefined ? task.dtstartIsDate : (task.allDay !== undefined ? task.allDay : undefined));
        if ('completed' in task) setDateProp('completed', task.completed);

        if ('priority' in task) {
          const p = parseInt(task.priority, 10);
          if (task.priority !== null && task.priority !== undefined && !isNaN(p) && p >= 0 && p <= 9) {
            setProp('priority', p);
          } else {
            vtodo.removeAllProperties('priority');
          }
        }

        if ('percentComplete' in task || 'percent-complete' in task) {
          const pctRaw = task.percentComplete !== undefined ? task.percentComplete : task['percent-complete'];
          const pct = parseInt(pctRaw, 10);
          if (pctRaw !== null && pctRaw !== undefined && !isNaN(pct) && pct >= 0 && pct <= 100) {
            setProp('percent-complete', pct);
          } else {
            vtodo.removeAllProperties('percent-complete');
          }
        }

        if ('recurrence' in task && task.recurrence !== undefined) {
          // Only act when recurrence is explicitly set to a value or null.
          // undefined means "caller did not include the field" → leave existing RRULE intact.
          if (task.recurrence) {
            const rruleSanitized = String(task.recurrence).split(/[\r\n]/)[0].replace(/^RRULE:/i, '').trim();
            try {
              const recur = ICAL.Recur.fromString(rruleSanitized);
              if (recur && recur.freq) {
                const prop = vtodo.getFirstProperty('rrule');
                if (prop) {
                  prop.setValue(recur);
                } else {
                  vtodo.addPropertyWithValue('rrule', recur);
                }
              } else {
                vtodo.removeAllProperties('rrule');
              }
            } catch (_) {
              vtodo.removeAllProperties('rrule');
            }
          } else {
            // null / '' → explicit removal requested
            vtodo.removeAllProperties('rrule');
          }
        }

        if ('categories' in task && task.categories !== undefined) {
          const rawCats = Array.isArray(task.categories)
            ? task.categories
            : (typeof task.categories === 'string' ? task.categories.split(',') : []);
          const normCats = rawCats.map(c => String(c).trim()).filter(Boolean);
          vtodo.removeAllProperties('categories');
          if (normCats.length > 0) {
            const prop = new ICAL.Property('categories', vtodo);
            prop.setValues(normCats);
            vtodo.addProperty(prop);
          }
        }

        if ('completedHistory' in task && Array.isArray(task.completedHistory)) {
          if (task.completedHistory.length > 0) {
            setProp('x-completed-dates', task.completedHistory.join(','));
          } else {
            vtodo.removeAllProperties('x-completed-dates');
          }
        }

        setDateProp('last-modified', new Date().toISOString());

        return comp.toString();
      }
    } catch (e) {
      console.warn('[taskToICS] Error updating existing ICS, falling back to new ICS generation:', e.message);
    }
  }

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
  if (task.status) {
    const cleanStatus = String(task.status).replace(/[\r\n\x00-\x1f]/g, '').trim().toUpperCase();
    const validStatus = ['NEEDS-ACTION', 'COMPLETED', 'IN-PROCESS', 'CANCELLED'].includes(cleanStatus)
      ? cleanStatus
      : (/^[A-Z0-9-]+$/.test(cleanStatus) ? cleanStatus : 'NEEDS-ACTION');
    lines.push(`STATUS:${validStatus}`);
  }

  const isValidDateVal = (val) => Boolean(val) && !isNaN(new Date(val).getTime());
  const isValidDurationVal = (val) => Boolean(val) && /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.test(String(val).trim());

  const hasDtstart = Boolean(task.dtstart && isValidDateVal(task.dtstart));

  if (!hasDtstart) {
    // RFC 5545 3.6.2: A VTODO without DTSTART MUST NOT have DURATION.
    if (task.due && isValidDateVal(task.due)) {
      if (task.dueIsDate || (typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due))) {
        const formatted = fmtDate(task.due);
        if (formatted) lines.push(`DUE;VALUE=DATE:${formatted}`);
      } else {
        const formatted = fmtDateTime(task.due);
        if (formatted) lines.push(`DUE:${formatted}`);
      }
    }
  } else {
    if (task.duration && isValidDurationVal(task.duration)) {
      lines.push(`DURATION:${String(task.duration).replace(/[\r\n]/g, '').trim()}`);
    } else if (task.due && isValidDateVal(task.due)) {
      if (task.dueIsDate || (typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due))) {
        const formatted = fmtDate(task.due);
        if (formatted) lines.push(`DUE;VALUE=DATE:${formatted}`);
      } else {
        const formatted = fmtDateTime(task.due);
        if (formatted) lines.push(`DUE:${formatted}`);
      }
    }
  }
  if (task.dtstart && isValidDateVal(task.dtstart)) {
    if (task.dtstartIsDate || (typeof task.dtstart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.dtstart))) {
      const formatted = fmtDate(task.dtstart);
      if (formatted) lines.push(`DTSTART;VALUE=DATE:${formatted}`);
    } else {
      const formatted = fmtDateTime(task.dtstart);
      if (formatted) lines.push(`DTSTART:${formatted}`);
    }
  }
  if (task.completed && isValidDateVal(task.completed)) {
    const formatted = fmtDateTime(task.completed);
    if (formatted) lines.push(`COMPLETED:${formatted}`);
  }
  if (task.priority !== null && task.priority !== undefined) {
    const p = parseInt(task.priority, 10);
    if (!isNaN(p) && p >= 0 && p <= 9) {
      lines.push(`PRIORITY:${p}`);
    }
  }
  if (task.percentComplete !== null && task.percentComplete !== undefined) {
    const pct = parseInt(task.percentComplete, 10);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      lines.push(`PERCENT-COMPLETE:${pct}`);
    }
  }
  if (Array.isArray(task.completedHistory) && task.completedHistory.length > 0) {
    lines.push(`X-COMPLETED-DATES:${task.completedHistory.join(',')}`);
  }
  if (task.categories) {
    const rawCats = Array.isArray(task.categories)
      ? task.categories
      : (typeof task.categories === 'string' ? task.categories.split(',') : []);
    const normCats = rawCats.map(c => String(c).trim()).filter(Boolean);
    if (normCats.length > 0) {
      lines.push(`CATEGORIES:${normCats.map(escIcal).join(',')}`);
    }
  }
  if (task.recurrence) {
    const rruleClean = String(task.recurrence).split(/[\r\n]/)[0].replace(/^RRULE:/i, '').trim();
    if (rruleClean) {
      try {
        const recur = ICAL.Recur.fromString(rruleClean);
        if (recur && recur.freq) {
          lines.push(`RRULE:${rruleClean}`);
        }
      } catch (_) {
        // Omit invalid RRULE to prevent property injection
      }
    }
  }

  lines.push('END:VTODO', 'END:VCALENDAR');

  return foldLines(lines.join('\n')) + '\r\n';
}

function advanceRecurringTask(task) {
  if (!task || !task.recurrence) return null;

  // Use ICAL.Recur iterator to correctly honour BYDAY, COUNT, UNTIL, INTERVAL.
  // A synthetic DTSTART is derived from task.dtstart or task.due so that the
  // iterator produces valid occurrences relative to the series origin.
  const rruleStr = String(task.recurrence).replace(/^RRULE:/i, '');

  let recur;
  try {
    recur = ICAL.Recur.fromString(rruleStr);
  } catch (_) {
    // Unparseable RRULE — fall back to simple arithmetic, no COUNT/UNTIL awareness.
    recur = null;
  }

  const baseDue = task.due ? new Date(task.due) : new Date();
  if (isNaN(baseDue.getTime())) return null;

  const currentHistory = Array.isArray(task.completedHistory) ? [...task.completedHistory] : [];
  const completionTime = task.completed || new Date().toISOString();
  const completedHistory = [...currentHistory, completionTime];

  if (recur) {
    // Build DTSTART: prefer explicit task.dtstart, otherwise use the due date
    // (the series effectively starts at its first occurrence).
    const dtStartMs = task.dtstart ? new Date(task.dtstart).getTime() : baseDue.getTime();
    const dtStart = isNaN(dtStartMs) ? baseDue : new Date(dtStartMs);
    const icalStart = ICAL.Time.fromJSDate(dtStart, true /* isUTC */);

    const iterator = recur.iterator(icalStart);
    const dueMs = baseDue.getTime();
    const maxSteps = 50000; // safety guard against infinite loops
    let steps = 0;
    let next;

    while (steps < maxSteps) {
      next = iterator.next();
      steps++;
      if (!next) {
        // Iterator exhausted (COUNT reached or UNTIL passed)
        return null;
      }
      const nextMs = next.toJSDate().getTime();
      if (nextMs > dueMs) {
        // Found the first occurrence strictly after the current due date
        return {
          ...task,
          due: next.toJSDate().toISOString(),
          status: 'NEEDS-ACTION',
          completed: null,
          percentComplete: 0,
          completedHistory
        };
      }
    }

    // Safety limit hit without finding a next occurrence
    return null;
  }

  // ICAL.Recur.fromString failed — fall back to simple interval arithmetic.
  // No COUNT/UNTIL awareness in this path.
  const rruleUpper = rruleStr.toUpperCase();
  let interval = 1;
  const matchInterval = rruleUpper.match(/INTERVAL=(\d+)/);
  if (matchInterval) interval = parseInt(matchInterval[1], 10) || 1;

  const nextDate = new Date(baseDue.getTime());
  if (rruleUpper.includes('FREQ=DAILY')) {
    nextDate.setUTCDate(nextDate.getUTCDate() + interval);
  } else if (rruleUpper.includes('FREQ=WEEKLY')) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 7 * interval);
  } else if (rruleUpper.includes('FREQ=MONTHLY')) {
    nextDate.setUTCMonth(nextDate.getUTCMonth() + interval);
  } else if (rruleUpper.includes('FREQ=YEARLY')) {
    nextDate.setUTCFullYear(nextDate.getUTCFullYear() + interval);
  } else {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  }

  return {
    ...task,
    due: nextDate.toISOString(),
    status: 'NEEDS-ACTION',
    completed: null,
    percentComplete: 0,
    completedHistory
  };
}

function updateAttendeePartstat(icsString, attendeeEmail, status, recurrenceId = null) {
  const jcal = ICAL.parse(icsString);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) return icsString;

  const targetEmail = (attendeeEmail || '').toLowerCase().replace(/^mailto:/i, '').trim();
  const newPartstat = (status || 'NEEDS-ACTION').toUpperCase();
  if (!targetEmail) return icsString;

  // Check if targetEmail exists as an attendee on ANY vevent component
  let existsOnAny = false;
  for (const vevent of vevents) {
    const attendees = vevent.getAllProperties('attendee');
    for (const prop of attendees) {
      const val = prop.getFirstValue();
      const email = (typeof val === 'string' ? val : '').toLowerCase().replace(/^mailto:/i, '').trim();
      if (email === targetEmail) {
        existsOnAny = true;
        break;
      }
    }
    if (existsOnAny) break;
  }

  // Issue #67: Do NOT invent attendees from unvalidated email
  if (!existsOnAny) {
    return icsString;
  }

  const targetRid = recurrenceId ? recurrenceId.toString() : null;

  if (targetRid) {
    // Specific occurrence RSVP
    let targetVevent = vevents.find(v => {
      const rid = v.getFirstPropertyValue('recurrence-id');
      if (!rid) return false;
      const ridStr = rid.toString();
      if (ridStr === targetRid) return true;
      try {
        const iso1 = /^\d{8}T\d{6}Z?$/.test(ridStr) ? ridStr.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z') : ridStr;
        const iso2 = /^\d{8}T\d{6}Z?$/.test(targetRid) ? targetRid.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z') : targetRid;
        const t1 = new Date(iso1).getTime();
        const t2 = new Date(iso2).getTime();
        if (!isNaN(t1) && t1 === t2) return true;
      } catch (e) {}
      return false;
    });

    if (!targetVevent) {
      // Create a detached override for targetRid cloned from master VEVENT
      const master = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
      targetVevent = new ICAL.Component(JSON.parse(JSON.stringify(master.jCal)));
      targetVevent.removeAllProperties('rrule');

      const ridProp = new ICAL.Property('recurrence-id', targetVevent);
      const dtstartProp = master.getFirstProperty('dtstart');
      const tzid = dtstartProp ? dtstartProp.getParameter('tzid') : null;
      if (tzid) ridProp.setParameter('tzid', tzid);

      try {
        const isoStr = /^\d{8}T\d{6}Z?$/.test(targetRid)
          ? targetRid.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z')
          : targetRid;
        const time = ICAL.Time.fromString(isoStr);
        if (dtstartProp && !time.isDate) {
          time.zone = dtstartProp.zone || ICAL.Timezone.utcTimezone;
        }
        ridProp.setValue(time);

        // Align start date to occurrence time
        const startProp = targetVevent.getFirstProperty('dtstart');
        if (startProp) startProp.setValue(time);
      } catch (e) {
        ridProp.setValue(targetRid);
      }

      targetVevent.addProperty(ridProp);
      comp.addSubcomponent(targetVevent);
    }

    const attendees = targetVevent.getAllProperties('attendee');
    for (const prop of attendees) {
      const val = prop.getFirstValue();
      const email = (typeof val === 'string' ? val : '').toLowerCase().replace(/^mailto:/i, '').trim();
      if (email === targetEmail) {
        prop.setParameter('partstat', newPartstat);
      }
    }
  } else {
    // Master series or single event (no recurrenceId) - update master VEVENT only
    const masterVevent = vevents.find(v => !v.getFirstProperty('recurrence-id')) || vevents[0];
    const attendees = masterVevent.getAllProperties('attendee');
    for (const prop of attendees) {
      const val = prop.getFirstValue();
      const email = (typeof val === 'string' ? val : '').toLowerCase().replace(/^mailto:/i, '').trim();
      if (email === targetEmail) {
        prop.setParameter('partstat', newPartstat);
      }
    }
  }

  return comp.toString();
}

function buildItipReply(event, attendeeEmail, status, attendeeName) {
  const uid = event?.uid || `${uuidv4()}@freeshard.webcalendar`;
  const dtstamp = fmtDateTime(new Date().toISOString());
  const partstat = (status || 'ACCEPTED').toUpperCase();
  const email = (attendeeEmail || '').replace(/^mailto:/i, '').trim();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Freeshard//WebCalendar iTIP//EN',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escIcal(event?.title || 'Event Reply')}`
  ];

  const recurrenceId = event?.recurrenceId || event?.recurrence_id;
  if (recurrenceId) {
    lines.push(`RECURRENCE-ID:${fmtDateTime(recurrenceId)}`);
  }

  if (event?.start) lines.push(`DTSTART:${fmtDateTime(event.start)}`);
  if (event?.end) lines.push(`DTEND:${fmtDateTime(event.end)}`);

  if (event?.organizer?.email) {
    const orgName = event.organizer.name || event.organizer.cn || event.organizer.displayName;
    const cn = orgName ? `;CN="${escParamVal(orgName)}"` : '';
    lines.push(`ORGANIZER${cn}:mailto:${escIcal(event.organizer.email.replace(/^mailto:/i, ''))}`);
  }

  const att = (event?.attendees || []).find(a => (a.email || '').toLowerCase().replace(/^mailto:/i, '').trim() === email.toLowerCase());
  const name = attendeeName || att?.name || att?.cn || att?.displayName || event?.attendeeName || '';
  const cn = name ? `;CN="${escParamVal(name)}"` : '';
  lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL${cn};PARTSTAT=${escParamVal(partstat)}:mailto:${escIcal(email)}`);

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return foldLines(lines.join('\n')) + '\r\n';
}

/**
 * Issue #261 — Detect a zero-edit VTODO save.
 *
 * Returns `true` if none of the "meaningful" task fields in `incomingTaskData`
 * differ from the parsed values in `existingIcs`.  Safe-defaults to `false`
 * (always write) when the existing ICS is missing or unparseable.
 *
 * Compared fields: title (SUMMARY), status (STATUS), description (DESCRIPTION),
 * due (DUE), dtstart (DTSTART), priority (PRIORITY), percentComplete (PERCENT-COMPLETE),
 * recurrence (RRULE — null vs string treated as distinct).
 *
 * @param {string|null} existingIcs   - Raw ICS string from CalDAV server.
 * @param {object}      incomingTaskData - Incoming PUT body fields (partial is OK).
 * @returns {boolean}
 */
function isNoOpTaskSave(existingIcs, incomingTaskData) {
  if (!existingIcs || typeof existingIcs !== 'string' || !existingIcs.trim()) return false;
  if (!incomingTaskData || typeof incomingTaskData !== 'object') return false;

  let existingTask;
  try {
    existingTask = parseICSToTask(existingIcs);
  } catch (_) {
    return false; // safe default
  }
  if (!existingTask) return false;

  const inc = incomingTaskData;

  // Normalise a recurrence value: strip RRULE: prefix, trim, treat null/undefined/''/false as null.
  const normRrule = (v) => {
    if (v === null || v === undefined || v === false || v === '') return null;
    return String(v).replace(/^RRULE:/i, '').trim() || null;
  };

  // Compare each meaningful field when the incoming payload provides it.
  // A field not present in the incoming payload is NOT compared (caller chose not to change it).
  const checks = [
    ['title', (e, i) => (e.title || '') === (i.title || '')],
    ['status', (e, i) => (e.status || '').toUpperCase() === (i.status || '').toUpperCase()],
    ['description', (e, i) => (e.description || null) === (i.description || null)],
    ['due', (e, i) => {
      if (!e.due && !i.due) return true;
      if (!e.due || !i.due) return false;
      return new Date(e.due).getTime() === new Date(i.due).getTime();
    }],
    ['dtstart', (e, i) => {
      if (!e.dtstart && !i.dtstart) return true;
      if (!e.dtstart || !i.dtstart) return false;
      return new Date(e.dtstart).getTime() === new Date(i.dtstart).getTime();
    }],
    ['priority', (e, i) => {
      const ep = (e.priority !== null && e.priority !== undefined) ? parseInt(e.priority, 10) : null;
      const ip = (i.priority !== null && i.priority !== undefined) ? parseInt(i.priority, 10) : null;
      return ep === ip;
    }],
    ['percentComplete', (e, i) => {
      const ep = (e.percentComplete !== null && e.percentComplete !== undefined) ? parseInt(e.percentComplete, 10) : null;
      const ip = (i.percentComplete !== null && i.percentComplete !== undefined) ? parseInt(i.percentComplete, 10) : null;
      return ep === ip;
    }],
    ['duration', (e, i) => (e.duration || null) === (i.duration || null)],
    ['recurrence', (e, i) => normRrule(e.recurrence) === normRrule(i.recurrence)]
  ];

  for (const [field, eq] of checks) {
    // Only compare a field if the incoming payload explicitly provides it.
    if (!(field in inc)) continue;
    if (!eq(existingTask, inc)) return false;
  }

  return true;
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
  reconcileTaskStatus,
  isNoOpTaskSave,
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
  const hasValidSyncTokenError = (xml && (xml.includes('valid-sync-token') || xml.includes('invalid-sync-token')));
  if (hasValidSyncTokenError && !syncToken) {
    return { syncToken: null, updated: [], deleted: [], invalidSyncToken: true };
  }
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
          etag: etag ? etag.trim() : null
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
  reconcileTaskStatus,
  isNoOpTaskSave,
  advanceRecurringTask,
  updateAttendeePartstat,
  buildItipReply,
  parseSyncCollectionResponse,
  isNoOpEventSave,
  updateWholeSeries,
  normalizeRecurrenceRule,
  resolveUrl,
  foldLines
};


