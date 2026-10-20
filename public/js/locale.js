/**
 * locale.js — the user's date and time conventions (#625).
 *
 * Week start, 12/24 h and time zone come from the user's calendar settings; where the user chose
 * nothing, from the browser: its region within the UI language (navigator.language "de-AT" →
 * de-AT conventions; a browser in another language gets the UI language's, so a German screen
 * never shows an English 12 h clock, #166) and the Intl time zone. The platform preference
 * (freeshard#168) goes between the two once shard_core offers it (CONCEPTS.md). Every date and
 * time on screen is formatted here with Intl, never with hand-written day or month names.
 */

import { store } from './store.js';

const WEEK_START_DAY = { mon: 1, sun: 0, sat: 6 };

// The UI language (index.html's lang) with the browser's region, e.g. "de-DE" or "de-AT".
export function uiLocale() {
  const lang = document.documentElement.lang || 'de';
  const browser = navigator.language || lang;
  return browser.split('-')[0] === lang ? browser : lang;
}

// 0 = Sunday … 6 = Saturday.
export function weekStartDay() {
  const chosen = store.get('weekStart');
  if (chosen) return WEEK_START_DAY[chosen];
  const locale = new Intl.Locale(uiLocale()).maximize();
  const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
  // Engines without week data (Firefox) get Monday, the ISO and German default.
  return info ? info.firstDay % 7 : 1;
}

// 'h12' or 'h23'.
export function hourCycle() {
  const chosen = store.get('timeFormat');
  if (chosen) return chosen === '12h' ? 'h12' : 'h23';
  const cycle = new Intl.DateTimeFormat(uiLocale(), { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h11' || cycle === 'h12' ? 'h12' : 'h23';
}

// The zone new events are created in: the user's choice, else the browser's.
export function preferredTimeZone() {
  return store.get('timeZone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map();

// An Intl.DateTimeFormat for the user's locale; options with an hour get the user's 12/24 h.
export function dateFormat(options) {
  const opts = 'hour' in options ? { ...options, hourCycle: hourCycle() } : options;
  if (opts.hourCycle === 'h12' && opts.hour === '2-digit') opts.hour = 'numeric'; // "1:00 PM", not "01:00 PM"
  const key = `${uiLocale()}|${JSON.stringify(opts)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(uiLocale(), opts));
  return formatters.get(key);
}

export const formatDate = (date, options) => dateFormat(options).format(new Date(date));

// "13:00" / "1:00 PM".
export const formatTime = (date, options = {}) => formatDate(date, { hour: '2-digit', minute: '2-digit', ...options });

// The day's name, e.g. "Mo" (short) or "Montag" (long).
export const weekdayName = (date, width = 'short') => formatDate(date, { weekday: width });

export const formatNumber = (n, options) => new Intl.NumberFormat(uiLocale(), options).format(n);

// Midnight of the first day of the user's week holding `date`; `firstDay` overrides the week
// start (the work week always starts on Monday).
export function startOfWeek(date, firstDay = weekStartDay()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7));
  return d;
}

// The seven days of a week in the user's order, starting from any week start date.
export function weekDays(start = startOfWeek(new Date())) {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

// "YYYY-MM-DD" of the browser-local calendar date (never toISOString, which is the UTC date).
export function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The calendar date of an all-day value ("2037-05-04" or "2037-05-04T00:00:00.000Z") as local midnight.
export function allDayDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
