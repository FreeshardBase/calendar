'use strict';

// #503: weekly hours are seven lists of time windows, indexed like Date#getUTCDay
// (0 = Sunday … 6 = Saturday). An empty list means the weekday is off.
const DEFAULT_WEEKLY_HOURS = [0, 1, 2, 3, 4, 5, 6].map(d => (d >= 1 && d <= 5 ? [{ start: '09:00', end: '17:00' }] : []));
const MAX_WINDOWS_PER_DAY = 12;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 12 * 60;
const MAX_BUFFER_MINUTES = 24 * 60;
const MAX_BOOKINGS_PER_DAY = 1000;
const MAX_NOTICE_MINUTES = 365 * 24 * 60;
const TIME_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))$/;
const MINUTE_MS = 60 * 1000;

// The code (server/utils/errorSanitizer.js) and parameters of a refused setting; the route
// answers them so the owner reads the reason in their language (#628). `weekday` is 0–6.
class BookingSettingsError extends Error {
  constructor(code, params) {
    super(params ? `${code} ${JSON.stringify(params)}` : code);
    this.bookingCode = code;
    this.params = params;
  }
}

function toMinutes(hhmm) {
  const m = TIME_RE.exec(hhmm);
  return m[3] ? 24 * 60 : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Validates weekly hours from a request and returns them with each day's windows
 * sorted by start. Throws BookingSettingsError for anything else, including
 * overlapping windows and a week without any window.
 */
function parseWeeklyHours(input) {
  if (!Array.isArray(input) || input.length !== 7) {
    throw new BookingSettingsError('BOOKING_WEEK_INCOMPLETE');
  }
  const week = input.map((day, d) => {
    if (!Array.isArray(day) || day.length > MAX_WINDOWS_PER_DAY) {
      throw new BookingSettingsError('BOOKING_TOO_MANY_WINDOWS', { weekday: d, max: MAX_WINDOWS_PER_DAY });
    }
    const windows = day.map(win => {
      if (!win || typeof win.start !== 'string' || typeof win.end !== 'string' ||
          !TIME_RE.test(win.start) || !TIME_RE.test(win.end) || win.start === '24:00') {
        throw new BookingSettingsError('BOOKING_WINDOW_FORMAT', { weekday: d });
      }
      if (toMinutes(win.start) >= toMinutes(win.end)) {
        throw new BookingSettingsError('BOOKING_WINDOW_ORDER', { weekday: d });
      }
      return { start: win.start, end: win.end };
    }).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (let i = 1; i < windows.length; i++) {
      if (toMinutes(windows[i].start) < toMinutes(windows[i - 1].end)) {
        throw new BookingSettingsError('BOOKING_WINDOW_OVERLAP', { weekday: d });
      }
    }
    return windows;
  });
  if (week.every(day => day.length === 0)) {
    throw new BookingSettingsError('BOOKING_NO_WINDOW');
  }
  return week;
}

function parseWholeNumber(value, { min, max, code }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BookingSettingsError(code, { min, max });
  }
  return value;
}

/**
 * The booking settings of a new page from a request body; absent settings get
 * the defaults (30-minute slots, Mon–Fri 09:00–17:00, no buffer, no daily cap, no notice).
 */
function parseBookingSettings(body) {
  return {
    durationMinutes: body.durationMinutes === undefined ? 30
      : parseWholeNumber(body.durationMinutes, { min: MIN_DURATION_MINUTES, max: MAX_DURATION_MINUTES, code: 'BOOKING_DURATION_RANGE' }),
    weeklyHours: body.weeklyHours === undefined ? DEFAULT_WEEKLY_HOURS : parseWeeklyHours(body.weeklyHours),
    bufferMinutes: body.bufferMinutes === undefined ? 0
      : parseWholeNumber(body.bufferMinutes, { min: 0, max: MAX_BUFFER_MINUTES, code: 'BOOKING_BUFFER_RANGE' }),
    maxBookingsPerDay: body.maxBookingsPerDay === undefined || body.maxBookingsPerDay === null ? null
      : parseWholeNumber(body.maxBookingsPerDay, { min: 1, max: MAX_BOOKINGS_PER_DAY, code: 'BOOKING_MAX_PER_DAY_RANGE' }),
    minNoticeMinutes: body.minNoticeMinutes === undefined ? 0
      : parseWholeNumber(body.minNoticeMinutes, { min: 0, max: MAX_NOTICE_MINUTES, code: 'BOOKING_NOTICE_RANGE' })
  };
}

/**
 * Calculates available time slots for a given availability page config and date.
 *
 * @param {Object} pageConfig
 * @param {number} pageConfig.durationMinutes
 * @param {Array<Array<{start: string, end: string}>>} pageConfig.weeklyHours - see parseWeeklyHours
 * @param {number} pageConfig.bufferMinutes - kept free before and after every busy interval
 * @param {number|null} pageConfig.maxBookingsPerDay - no slots once the page has this many bookings that day
 * @param {Array<{start: string, end: string}>} existingEvents
 * @param {Array<{startTime: string, endTime: string}>} existingBookings - this page's bookings on dateStr
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {Array<{startTime: string, endTime: string}>}
 */
function calculateFreeSlots(pageConfig, existingEvents = [], existingBookings = [], dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return [];
  }

  const dayStartMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  if (isNaN(dayStartMs)) {
    return [];
  }

  const { maxBookingsPerDay } = pageConfig;
  if (maxBookingsPerDay !== null && existingBookings.length >= maxBookingsPerDay) {
    return [];
  }

  const durationMinutes = parseInt(pageConfig.durationMinutes, 10) || 30;
  const bufferMs = pageConfig.bufferMinutes * MINUTE_MS;
  const busy = [
    ...existingEvents.map(ev => [new Date(ev.start).getTime(), new Date(ev.end).getTime()]),
    ...existingBookings.map(b => [new Date(b.startTime).getTime(), new Date(b.endTime).getTime()])
  ];

  const windows = pageConfig.weeklyHours[new Date(dayStartMs).getUTCDay()];
  const availableSlots = [];
  for (const win of windows) {
    const windowEnd = toMinutes(win.end);
    for (let currentMin = toMinutes(win.start); currentMin + durationMinutes <= windowEnd; currentMin += durationMinutes) {
      const slotStartMs = dayStartMs + currentMin * MINUTE_MS;
      const slotEndMs = slotStartMs + durationMinutes * MINUTE_MS;
      const collides = busy.some(([s, e]) => s - bufferMs < slotEndMs && e + bufferMs > slotStartMs);
      if (collides) continue;
      availableSlots.push({
        startTime: new Date(slotStartMs).toISOString(),
        endTime: new Date(slotEndMs).toISOString()
      });
    }
  }

  return availableSlots;
}

module.exports = {
  calculateFreeSlots,
  parseBookingSettings,
  BookingSettingsError,
  DEFAULT_WEEKLY_HOURS
};
