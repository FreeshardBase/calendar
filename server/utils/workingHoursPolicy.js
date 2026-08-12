'use strict';

/**
 * Utility for evaluating working hours & out-of-office policy rules.
 */

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function evaluateWorkingHoursPolicy(startTime, endTime, policy) {
  const start = parseDate(startTime);
  const end = parseDate(endTime);

  if (!start || !end) {
    return {
      outsideWorkingHours: false,
      isOutOfOffice: false,
      shouldAutoDecline: false,
      declineMessage: ''
    };
  }

  const workDays = (policy.workDays || '1,2,3,4,5')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const startHourPolicy = policy.startHour !== undefined ? Number(policy.startHour) : 9;
  const endHourPolicy = policy.endHour !== undefined ? Number(policy.endHour) : 17;
  const autoDeclineEnabled = !!policy.autoDecline;

  // Day of week check (JS getDay(): 0 = Sun, 1 = Mon, ..., 6 = Sat)
  const dayOfWeek = start.getUTCDay(); // using UTC for consistency
  const isWorkDay = workDays.includes(dayOfWeek);

  // Hour check
  const startHour = start.getUTCHours();
  const endHour = end.getUTCHours() + (end.getUTCMinutes() > 0 ? 1 : 0);

  const isWithinHours = startHour >= startHourPolicy && endHour <= endHourPolicy;
  const outsideWorkingHours = !isWorkDay || !isWithinHours;

  // Out of Office (OOO) check
  let isOutOfOffice = false;
  if (policy.oooEnabled && policy.oooStart && policy.oooEnd) {
    const oooStart = parseDate(policy.oooStart);
    const oooEnd = parseDate(policy.oooEnd);
    if (oooStart && oooEnd) {
      // Set oooEnd to end of day if only YYYY-MM-DD was provided
      if (typeof policy.oooEnd === 'string' && policy.oooEnd.length === 10) {
        oooEnd.setUTCHours(23, 59, 59, 999);
      }
      if (start < oooEnd && end > oooStart) {
        isOutOfOffice = true;
      }
    }
  }

  const shouldAutoDecline = autoDeclineEnabled && (outsideWorkingHours || isOutOfOffice);

  let declineMessage = '';
  if (shouldAutoDecline) {
    if (isOutOfOffice) {
      declineMessage = policy.oooMessage || 'Out of Office / Abwesend';
    } else {
      declineMessage = 'Termin liegt außerhalb der geregelten Arbeitszeiten.';
    }
  }

  return {
    outsideWorkingHours,
    isOutOfOffice,
    shouldAutoDecline,
    declineMessage
  };
}

module.exports = {
  evaluateWorkingHoursPolicy
};
