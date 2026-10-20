// Issue #509: everything the week/day grid needs to show a second time zone.
// All values come from Intl for the actual instant, so they stay right across DST changes.

import { uiLocale, formatTime } from './locale.js';

// Every IANA zone the browser knows. Engines leave UTC out of the list, though it is a zone.
export function allTimeZones() {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : [...zones, 'UTC'].sort();
}

// "UTC+2", "UTC-2:30", "UTC" — the zone's offset from UTC at that instant.
export function zoneOffsetLabel(timeZone, instant) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant).find(p => p.type === 'timeZoneName').value;
  if (name === 'GMT') return 'UTC'; // longOffset names a zero offset plain "GMT"
  const m = name.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Unexpected offset name "${name}" for ${timeZone}`);
  const hours = String(Number(m[2]));
  return `UTC${m[1]}${m[3] === '00' ? hours : `${hours}:${m[3]}`}`;
}

// The zone's abbreviation at that instant ("MESZ", "EDT"), or null where Intl has none but a
// GMT offset, which the offset label already says.
export function zoneAbbreviation(timeZone, instant) {
  for (const locale of [uiLocale(), 'en-US']) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
      .formatToParts(instant).find(p => p.type === 'timeZoneName').value;
    if (!/^(GMT|UTC)/.test(name)) return name;
  }
  return null;
}

// "14:30" / "2:30 PM" — the wall-clock time of the instant in that zone.
export function timeInZone(timeZone, instant) {
  return formatTime(instant, { timeZone });
}

// The browser's own zone, in which the grid lays out its hours.
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Zones whose name contains the query; spaces match the underscores of "St_Johns".
export function searchTimeZones(query, limit = 30) {
  const q = query.trim().toLowerCase().replace(/\s+/g, '_');
  if (!q) return [];
  return allTimeZones().filter(z => z.toLowerCase().includes(q)).slice(0, limit);
}
