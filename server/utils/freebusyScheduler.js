'use strict';

const ICAL = require('ical.js');

/**
 * Checks whether an event overlaps with [windowStartMs, windowEndMs] and is busy (opaque).
 * Returns busy interval or null.
 */
function isEventBusyInWindow(event, windowStartMs, windowEndMs, excludeEventUid = null) {
  if (excludeEventUid && event.uid === excludeEventUid) {
    return null;
  }

  // Check transparency (TRANSP: TRANSPARENT means free/non-blocking)
  if (event.transp && (event.transp.toUpperCase() === 'TRANSPARENT')) {
    return null;
  }

  let startMs = event.start ? new Date(event.start).getTime() : NaN;
  let endMs = event.end ? new Date(event.end).getTime() : NaN;

  if (isNaN(startMs)) return null;
  if (isNaN(endMs)) {
    // Default to 1 hour duration if end time is missing
    endMs = startMs + 3600000;
  }

  // Check overlap with interval
  if (startMs < windowEndMs && endMs > windowStartMs) {
    return {
      uid: event.uid || null,
      title: event.title || 'Busy',
      start: new Date(Math.max(startMs, windowStartMs)).toISOString(),
      end: new Date(Math.min(endMs, windowEndMs)).toISOString(),
      rawStart: new Date(startMs).toISOString(),
      rawEnd: new Date(endMs).toISOString(),
      transparent: false
    };
  }

  return null;
}

/**
 * Query participant availability given a list of participant identifiers (user IDs or emails).
 */
async function queryParticipantAvailability({ participants = [], startTime, endTime, excludeEventUid = null, getEventsForUserFn }) {
  const windowStartMs = new Date(startTime).getTime();
  const windowEndMs = new Date(endTime).getTime();

  if (isNaN(windowStartMs) || isNaN(windowEndMs) || windowStartMs >= windowEndMs) {
    throw new Error('Invalid startTime or endTime window');
  }

  const results = [];
  let overallAvailable = true;

  for (const participant of participants) {
    const pStr = typeof participant === 'string' ? participant.trim() : (participant.userId || participant.email || '');
    if (!pStr) continue;

    let events = [];
    if (getEventsForUserFn) {
      events = await getEventsForUserFn(pStr, new Date(windowStartMs), new Date(windowEndMs));
    }

    const busySlots = [];
    for (const ev of events) {
      const busy = isEventBusyInWindow(ev, windowStartMs, windowEndMs, excludeEventUid);
      if (busy) {
        busySlots.push(busy);
      }
    }

    const isAvailable = busySlots.length === 0;
    if (!isAvailable) {
      overallAvailable = false;
    }

    results.push({
      participant: pStr,
      isAvailable,
      status: isAvailable ? 'FREE' : 'BUSY',
      busySlots
    });
  }

  return {
    startTime: new Date(windowStartMs).toISOString(),
    endTime: new Date(windowEndMs).toISOString(),
    overallAvailable,
    participants: results
  };
}

/**
 * Computes common free time slots where ALL specified participants are available.
 */
async function findCommonFreeSlots({
  participants = [],
  startDate,
  endDate,
  durationMinutes = 30,
  workHoursStart = 9,
  workHoursEnd = 17,
  getEventsForUserFn
}) {
  const startDay = new Date(startDate);
  const endDay = new Date(endDate);
  durationMinutes = parseInt(durationMinutes, 10) || 30;
  const durationMs = durationMinutes * 60 * 1000;

  if (isNaN(startDay.getTime()) || isNaN(endDay.getTime()) || startDay > endDay) {
    throw new Error('Invalid startDate or endDate range');
  }

  const commonSlots = [];
  const curr = new Date(startDay);

  while (curr <= endDay) {
    const year = curr.getUTCFullYear();
    const month = String(curr.getUTCMonth() + 1).padStart(2, '0');
    const day = String(curr.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const dayWorkStartMs = Date.parse(`${dateStr}T${String(workHoursStart).padStart(2, '0')}:00:00Z`);
    const dayWorkEndMs = Date.parse(`${dateStr}T${String(workHoursEnd).padStart(2, '0')}:00:00Z`);

    if (!isNaN(dayWorkStartMs) && !isNaN(dayWorkEndMs)) {
      for (let slotStartMs = dayWorkStartMs; slotStartMs + durationMs <= dayWorkEndMs; slotStartMs += durationMs) {
        const slotEndMs = slotStartMs + durationMs;
        const slotStartIso = new Date(slotStartMs).toISOString();
        const slotEndIso = new Date(slotEndMs).toISOString();

        const queryRes = await queryParticipantAvailability({
          participants,
          startTime: slotStartIso,
          endTime: slotEndIso,
          getEventsForUserFn
        });

        if (queryRes.overallAvailable) {
          commonSlots.push({
            startTime: slotStartIso,
            endTime: slotEndIso,
            date: dateStr,
            durationMinutes
          });
        }
      }
    }

    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  return commonSlots;
}

/**
 * Formats a Date to iCalendar UTC timestamp format (YYYYMMDDTHHMMSSZ).
 */
function formatICalDate(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Builds standard RFC 5545 VFREEBUSY string.
 */
function buildVFreeBusy({ organizerEmail = 'testuser@example.com', startTime, endTime, busySlots = [] }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FreeShard//WebCalendar VFREEBUSY Engine//EN',
    'BEGIN:VFREEBUSY',
    `ORGANIZER:mailto:${organizerEmail}`,
    `DTSTART:${formatICalDate(startTime)}`,
    `DTEND:${formatICalDate(endTime)}`
  ];

  for (const slot of busySlots) {
    const startStr = formatICalDate(slot.start || slot.startTime);
    const endStr = formatICalDate(slot.end || slot.endTime);
    if (startStr && endStr) {
      lines.push(`FREEBUSY;FBTYPE=BUSY:${startStr}/${endStr}`);
    }
  }

  lines.push('END:VFREEBUSY');
  lines.push('END:VCALENDAR');

  return lines.join('\r\n');
}

/**
 * Parses RFC 5545 VFREEBUSY content into structured data.
 */
function parseVFreeBusy(icsString) {
  try {
    const jcal = ICAL.parse(icsString);
    const comp = new ICAL.Component(jcal);
    const vfreebusy = comp.getFirstSubcomponent('vfreebusy');

    if (!vfreebusy) {
      throw new Error('No VFREEBUSY component found in iCalendar string');
    }

    const organizer = vfreebusy.getFirstPropertyValue('organizer') || '';
    const dtstart = vfreebusy.getFirstPropertyValue('dtstart') ? vfreebusy.getFirstPropertyValue('dtstart').toJSDate().toISOString() : null;
    const dtend = vfreebusy.getFirstPropertyValue('dtend') ? vfreebusy.getFirstPropertyValue('dtend').toJSDate().toISOString() : null;

    const freebusyProps = vfreebusy.getAllProperties('freebusy');
    const periods = [];

    for (const prop of freebusyProps) {
      const fbtype = prop.getParameter('fbtype') || 'BUSY';
      const values = prop.getValues();
      for (const val of values) {
        if (val && val.start && val.end) {
          periods.push({
            fbtype,
            start: val.start.toJSDate().toISOString(),
            end: val.end.toJSDate().toISOString()
          });
        }
      }
    }

    return {
      organizer,
      dtstart,
      dtend,
      periods
    };
  } catch (err) {
    throw new Error(`Failed to parse VFREEBUSY: ${err.message}`);
  }
}

module.exports = {
  isEventBusyInWindow,
  queryParticipantAvailability,
  findCommonFreeSlots,
  buildVFreeBusy,
  parseVFreeBusy,
  formatICalDate
};
