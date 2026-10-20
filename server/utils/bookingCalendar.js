'use strict';

/**
 * bookingCalendar — Issue #345
 *
 * A public booking page acts for its owner without a session: it reads the
 * owner's busy time from the calendars the page names and writes each booking
 * as a VEVENT into the page's calendar. Every access is re-checked against the
 * owner's current permissions, so a page cannot outlive a revoked share.
 */

const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { getClientForAccount } = require('../caldav/helper');
const { isDavMultistatus } = require('../caldav/client');
const { parseEventList, resolveUrl } = require('../caldav/parser');
const { eventToICS } = require('./ical');
const { checkCalendarAccess } = require('./calendarAuth');

const PAGE_UNAVAILABLE = 'Diese Buchungsseite ist derzeit nicht verfügbar.';

function pageUnavailable(detail) {
  const err = new Error(detail);
  err.userCode = 'BOOKING_PAGE_UNAVAILABLE';
  err.userMessage = PAGE_UNAVAILABLE;
  err.status = 503;
  return err;
}

/**
 * Run a CalDAV call for the page. Its failure (e.g. the owner's expired
 * credentials) is the owner's problem: the booker learns only that the page is
 * unavailable, the log keeps the cause.
 */
async function upstream(what, fn) {
  try {
    return await fn();
  } catch (err) {
    const wrapped = pageUnavailable(`${what}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/** The accounts the owner's session would carry (server/index.js builds the same list). */
async function loadOwnerAccounts(ownerId) {
  const accounts = await Db.getAccounts(ownerId);
  if (process.env.CALDAVURL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD &&
      !accounts.some(a => a.id === 'env-default')) {
    accounts.unshift({
      id: 'env-default',
      url: process.env.CALDAVURL,
      username: process.env.CALDAV_USERNAME,
      password: process.env.CALDAV_PASSWORD
    });
  }
  if (!process.env.DISABLE_INTERNAL_CALDAV) {
    // #144: the owner's collection root is the owner's user id.
    const internalUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
    const internal = accounts.find(a => a.id === 'internal-caldav');
    if (internal) {
      internal.username = ownerId;
      internal.url = `${internalUrl}/${ownerId}/`;
    } else {
      accounts.unshift({
        id: 'internal-caldav',
        url: `${internalUrl}/${ownerId}/`,
        username: ownerId,
        password: process.env.SYSTEM_SYNC_SECRET
      });
    }
  }
  return accounts;
}

/**
 * Resolve calendarId for ownerId with the given access level. Throws (503 to
 * the booker) when the owner (no longer) has that access.
 */
async function openOwnerCalendar(ownerId, calendarId, access) {
  const accounts = await loadOwnerAccounts(ownerId);
  const result = await checkCalendarAccess({ session: { userId: ownerId, accounts } }, calendarId, access);
  if (!result.allowed) {
    throw pageUnavailable(`Booking page owner ${ownerId} lacks ${access} access to ${calendarId}: ${result.reason}`);
  }
  const sep = calendarId.indexOf('::');
  const accountId = calendarId.slice(0, sep);
  const account = accounts.find(a => a.id === accountId);
  if (!account) {
    throw pageUnavailable(`Account ${accountId} of booking page owner ${ownerId} is not available`);
  }
  const client = await upstream(`Opening ${calendarId}`, () => getClientForAccount(account));
  return { account, client, calendarUrl: resolveUrl(account.url, calendarId.slice(sep + 2)) };
}

/** The page's calendar plus every calendar the owner selected as busy, without duplicates. */
function busyCalendarIdsFor(page) {
  return [...new Set([page.calendarId, ...page.busyCalendarIds])];
}

/**
 * Busy intervals [{ start, end }] of the page owner in [windowStart, windowEnd):
 * recurrence-expanded, ignoring TRANSP:TRANSPARENT and cancelled events.
 * Any calendar that cannot be read or parsed fails the whole query, so a slot
 * is never offered on incomplete information.
 */
async function getBusyIntervals(page, windowStart, windowEnd) {
  const busy = [];
  for (const calendarId of busyCalendarIdsFor(page)) {
    const { account, client, calendarUrl } = await openOwnerCalendar(page.userId, calendarId, 'read');
    const xml = await upstream(`Reading busy calendar ${calendarId}`, () => client.getEvents(calendarUrl, windowStart, windowEnd));
    if (!isDavMultistatus(xml)) {
      throw pageUnavailable(`Busy calendar ${calendarId} did not answer with a DAV multistatus`);
    }
    const parseErrors = [];
    const events = parseEventList(xml, calendarId, account.id, calendarUrl, windowStart, windowEnd, parseErrors);
    if (parseErrors.length > 0) {
      throw pageUnavailable(`Busy calendar ${calendarId} has unparseable events: ${parseErrors.map(e => e.href).join(', ')}`);
    }
    for (const ev of events) {
      if (String(ev.transp || '').toUpperCase() === 'TRANSPARENT') continue;
      if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
      if (!ev.start) continue;
      busy.push({ start: ev.start, end: ev.end || ev.start });
    }
  }
  return busy;
}

/**
 * Write the booking as a VEVENT into the page's calendar.
 * Returns { uid, remove } where remove() deletes the event again.
 */
async function createBookingEvent(page, { startTime, endTime, guestName, guestEmail, notes }) {
  const { client, calendarUrl } = await openOwnerCalendar(page.userId, page.calendarId, 'write');
  const ownerEmail = await Db.getUserEmailByUserId(page.userId);
  const uid = uuidv4();
  const ics = eventToICS({
    uid,
    title: `${page.title}: ${guestName}`,
    start: startTime,
    end: endTime,
    description: notes || null,
    organizer: ownerEmail ? { email: ownerEmail } : null,
    attendees: [{ name: guestName, email: guestEmail, status: 'ACCEPTED' }]
  });
  const eventUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';
  await upstream(`Writing booking event to ${page.calendarId}`, () => client.put(eventUrl, ics, null));
  return { uid, remove: () => client.delete(eventUrl) };
}

module.exports = { getBusyIntervals, createBookingEvent };
