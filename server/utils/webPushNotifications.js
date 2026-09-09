'use strict';

/**
 * Parses an RFC 5545 ISO 8601 duration string (e.g., -PT15M, -PT1H, -P1D, PT5M)
 * into a millisecond offset number.
 */
const { parseTriggerOffsetMs } = require('./ical');

/**
 * Parses an RFC 5545 ISO 8601 duration string (e.g., -PT15M, -PT1H, -P1D, PT5M)
 * into a millisecond offset number. Returns null for corrupted/invalid triggers.
 */
function parseValarmOffset(triggerStr, eventStart) {
  if (!triggerStr || typeof triggerStr === 'object') return null;
  return parseTriggerOffsetMs(triggerStr, eventStart);
}

/**
 * Calculates the exact timestamp (ms) when a VALARM trigger fires relative to event start time.
 * Returns null if eventStart or triggerStr is invalid or corrupted.
 */
function calculateAlarmTime(eventStart, triggerStr) {
  if (!eventStart) return null;
  const startDate = new Date(eventStart);
  if (isNaN(startDate.getTime())) return null;
  const offsetMs = parseValarmOffset(triggerStr, eventStart);
  if (offsetMs === null || isNaN(offsetMs)) return null;
  return startDate.getTime() + offsetMs;
}

/**
 * Evaluates upcoming alarms across a list of event objects.
 */
function evaluateUpcomingAlarms(events, options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const windowMinutes = options.windowMinutes !== undefined ? options.windowMinutes : 15;
  const windowEndMs = nowMs + windowMinutes * 60 * 1000;
  const lookbackMinutes = options.lookbackMinutes !== undefined ? options.lookbackMinutes : (options.graceMinutes !== undefined ? options.graceMinutes : 1440);
  const graceStartMs = nowMs - lookbackMinutes * 60 * 1000;

  const triggered = [];
  if (!Array.isArray(events)) return triggered;

  for (const ev of events) {
    if (!ev || !ev.start || !Array.isArray(ev.alarms)) continue;

    for (const alarm of ev.alarms) {
      const triggerStr = alarm.trigger || alarm.TRIGGER;
      if (!triggerStr) continue;
      const alarmTime = calculateAlarmTime(ev.start, triggerStr);
      if (alarmTime === null || isNaN(alarmTime)) continue;

      // Trigger if alarm falls within [graceStartMs, windowEndMs]
      if (alarmTime >= graceStartMs && alarmTime <= windowEndMs) {
        triggered.push({
          eventId: ev.id || ev.uid,
          title: ev.title || ev.summary || 'Unbenannter Termin',
          start: ev.start,
          trigger: triggerStr,
          alarmTime,
          action: alarm.action || 'DISPLAY'
        });
      }
    }
  }

  return triggered;
}

/**
 * Formats a standard Web Push notification payload object for a triggered alarm.
 */
function formatPushPayload(alarm) {
  const eventTitle = alarm.title || 'Termin';
  const startTimeStr = alarm.start ? new Date(alarm.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';

  return {
    title: `Erinnerung: ${eventTitle}`,
    body: startTimeStr ? `Erinnerung für "${eventTitle}" um ${startTimeStr}` : `Erinnerung für "${eventTitle}"`,
    icon: '/icon-192.png',
    data: {
      eventId: alarm.eventId,
      alarmTime: alarm.alarmTime,
      url: '/'
    }
  };
}

module.exports = {
  parseValarmOffset,
  calculateAlarmTime,
  evaluateUpcomingAlarms,
  formatPushPayload
};
