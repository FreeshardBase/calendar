'use strict';

/**
 * Parses an RFC 5545 ISO 8601 duration string (e.g., -PT15M, -PT1H, -P1D, PT5M)
 * into a millisecond offset number.
 */
function parseValarmOffset(triggerStr) {
  if (typeof triggerStr !== 'string') return 0;
  const isNegative = triggerStr.startsWith('-');
  const clean = triggerStr.replace(/^[+-]/, '');

  const regex = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
  const match = clean.match(regex);
  if (!match) return 0;

  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);

  const totalMs = (days * 24 * 3600 + hours * 3600 + minutes * 60 + seconds) * 1000;
  return isNegative ? -totalMs : totalMs;
}

/**
 * Calculates the exact timestamp (ms) when a VALARM trigger fires relative to event start time.
 */
function calculateAlarmTime(eventStart, triggerStr) {
  const startDate = new Date(eventStart);
  if (isNaN(startDate.getTime())) return Date.now();
  const offsetMs = parseValarmOffset(triggerStr);
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
      const triggerStr = alarm.trigger || alarm.TRIGGER || '-PT15M';
      const alarmTime = calculateAlarmTime(ev.start, triggerStr);

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
