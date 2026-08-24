/**
 * timezoneGrid.js — Dual Timezone Grid & Secondary Timeline Engine.
 * Supports standard IANA timezones and hour conversion for multi-timezone calendar views.
 */

const SUPPORTED_TIMEZONES = [
  { id: 'Europe/Berlin', label: 'Berlin (MEZ/MESZ)', city: 'Berlin' },
  { id: 'Europe/London', label: 'London (GMT/BST)', city: 'London' },
  { id: 'America/New_York', label: 'New York (EST/EDT)', city: 'New York' },
  { id: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)', city: 'Los Angeles' },
  { id: 'Asia/Tokyo', label: 'Tokio (JST)', city: 'Tokio' },
  { id: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)', city: 'Sydney' },
  { id: 'UTC', label: 'UTC (Koordinierte Weltzeit)', city: 'UTC' }
];

/**
 * Calculates timezone offset in minutes relative to UTC for a specific date.
 */
function getTimezoneOffsetMinutes(tzName = 'UTC', date = new Date()) {
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      timeZoneName: 'longOffset',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    });
    const parts = format.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';

    if (tzPart === 'GMT' || tzPart === 'UTC') return 0;
    const match = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const mins = parseInt(match[3] || '0', 10);
    return sign * (hours * 60 + mins);
  } catch (err) {
    return 0;
  }
}

/**
 * Returns short abbreviation or offset string (e.g., 'CET', 'EDT', 'UTC+1').
 */
function getTimezoneAbbr(tzName = 'UTC', date = new Date()) {
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      timeZoneName: 'short'
    });
    const parts = format.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value;
    if (tzPart) return tzPart;

    const offsetMins = getTimezoneOffsetMinutes(tzName, date);
    const hrs = Math.floor(Math.abs(offsetMins) / 60);
    const sign = offsetMins >= 0 ? '+' : '-';
    return `UTC${sign}${hrs}`;
  } catch (err) {
    return tzName;
  }
}

/**
 * Formats primary & secondary headers for UI display.
 */
function formatTimezoneHeader(primaryTz, secondaryTz, date = new Date()) {
  const priObj = SUPPORTED_TIMEZONES.find(t => t.id === primaryTz);
  const secObj = SUPPORTED_TIMEZONES.find(t => t.id === secondaryTz);

  const priCity = priObj ? priObj.city : primaryTz.split('/').pop().replace('_', ' ');
  const secCity = secObj ? secObj.city : secondaryTz.split('/').pop().replace('_', ' ');

  const priAbbr = getTimezoneAbbr(primaryTz, date);
  const secAbbr = getTimezoneAbbr(secondaryTz, date);

  return {
    primary: `${priCity} (${priAbbr})`,
    secondary: `${secCity} (${secAbbr})`
  };
}

/**
 * Given a base hour (0..23) on a date in primaryTz, computes the formatted hour labels
 * for primaryTz and secondaryTz.
 */
function getDualHourLabel(baseHour, date = new Date(), primaryTz = 'Europe/Berlin', secondaryTz = 'America/New_York') {
  const priOffset = getTimezoneOffsetMinutes(primaryTz, date);
  const secOffset = getTimezoneOffsetMinutes(secondaryTz, date);

  const diffMins = secOffset - priOffset;
  let totalSecMins = baseHour * 60 + diffMins;
  totalSecMins = ((totalSecMins % 1440) + 1440) % 1440;

  const secHour = Math.floor(totalSecMins / 60);
  const secMin = totalSecMins % 60;

  const fmt = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  return {
    primary: fmt(baseHour, 0),
    secondary: fmt(secHour, secMin)
  };
}

module.exports = {
  SUPPORTED_TIMEZONES,
  getTimezoneOffsetMinutes,
  getTimezoneAbbr,
  formatTimezoneHeader,
  getDualHourLabel
};
