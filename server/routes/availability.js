'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { calculateFreeSlots, parseBookingSettings, BookingSettingsError } = require('../utils/availabilityBooking');
const { checkCalendarAccess, queueSyncForCalendar } = require('../utils/calendarAuth');
const { getBusyIntervals, createBookingEvent } = require('../utils/bookingCalendar');
const {
  createRateLimiter, createRateBudget, TOO_MANY_REQUESTS,
  BOOKING_IP_RATE_LIMIT, BOOKING_PAGE_RATE_LIMIT, AVAILABILITY_READ_BUDGET
} = require('../utils/rateLimit');

const MAX_BUSY_CALENDARS = 20;
const MAX_GUEST_NAME = 200;
const MAX_GUEST_EMAIL = 254;
const MAX_NOTES = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const BOOKING_HORIZON_MS = 365 * DAY_MS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// #530: how long the public slot query reuses the slots of one (page, date).
const SLOT_CACHE_TTL_MS = 60 * 1000;

const bookingIpLimiter = createRateLimiter(BOOKING_IP_RATE_LIMIT);
const bookingPageLimiter = createRateLimiter(BOOKING_PAGE_RATE_LIMIT);
const takeAvailabilityRead = createRateBudget(AVAILABILITY_READ_BUDGET);

// Bookings of one owner run one at a time: the free-slot check, the calendar
// write and the booking row form one step (the app is one process per shard).
const ownerQueues = new Map();
function serializeForOwner(ownerId, fn) {
  const run = (ownerQueues.get(ownerId) || Promise.resolve()).then(fn);
  const settled = run.then(() => undefined, () => undefined);
  ownerQueues.set(ownerId, settled);
  settled.then(() => {
    if (ownerQueues.get(ownerId) === settled) ownerQueues.delete(ownerId);
  });
  return run;
}

/**
 * Free slots of the page on dateStr: owner's busy time and existing bookings
 * removed, only slots from now plus the page's minimum notice up to one year ahead.
 */
async function freeSlotsFor(page, dateStr, { cached = false } = {}) {
  const now = Date.now();
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  if (dayEnd.getTime() <= now || dayStart.getTime() > now + BOOKING_HORIZON_MS) return [];
  const slots = await (cached ? cachedDaySlots(page, dateStr, dayStart, dayEnd) : daySlots(page, dateStr, dayStart, dayEnd));
  const earliest = now + page.minNoticeMinutes * 60 * 1000;
  return slots.filter(slot => new Date(slot.startTime).getTime() > earliest);
}

async function daySlots(page, dateStr, dayStart, dayEnd) {
  const busy = await getBusyIntervals(page, dayStart, dayEnd);
  const existingBookings = await Db.getSlotBookingsForPage(page.id, dateStr);
  return calculateFreeSlots(page, busy, existingBookings, dateStr);
}

// #530: the anonymous slot query reads the owner's calendars at most once per
// (page, date) and SLOT_CACHE_TTL_MS; concurrent queries share the pending read.
// Each read uses the page's AVAILABILITY_READ_BUDGET, keyed by page id, so neither
// cached answers nor requests for unknown pages or bad dates use it up.
// Bookings never use the cache: they re-check against fresh data.
const slotCache = new Map(); // `${page.id}|${dateStr}` -> { userId, expiresAt, promise }

class ReadBudgetExhausted extends Error {
  constructor(retryAfter) {
    super(`Availability read budget exhausted, retry after ${retryAfter}s`);
    this.retryAfter = retryAfter;
  }
}

function cachedDaySlots(page, dateStr, dayStart, dayEnd) {
  const now = Date.now();
  for (const [k, entry] of slotCache) {
    if (entry.expiresAt <= now) slotCache.delete(k);
  }
  const key = `${page.id}|${dateStr}`;
  const hit = slotCache.get(key);
  if (hit) return hit.promise;
  const retryAfter = takeAvailabilityRead(page.id);
  if (retryAfter !== null) throw new ReadBudgetExhausted(retryAfter);
  const entry = { userId: page.userId, expiresAt: now + SLOT_CACHE_TTL_MS, promise: daySlots(page, dateStr, dayStart, dayEnd) };
  slotCache.set(key, entry);
  // Only evicts the failed read; the caller still receives its error through entry.promise.
  entry.promise.catch(() => {
    if (slotCache.get(key) === entry) slotCache.delete(key);
  });
  return entry.promise;
}

/** A booking changes the busy time of every page of its owner. */
function dropCachedSlotsOfOwner(userId) {
  for (const [k, entry] of slotCache) {
    if (entry.userId === userId) slotCache.delete(k);
  }
}

function isValidDate(dateStr) {
  return DATE_RE.test(dateStr) && !isNaN(new Date(`${dateStr}T00:00:00.000Z`).getTime());
}

// Rejects malformed booking requests before they count against the page budget.
function validateBooking(req, res, next) {
  const { startTime, guestName, guestEmail, notes } = req.body;
  if (typeof startTime !== 'string' || typeof guestName !== 'string' || typeof guestEmail !== 'string' ||
      !startTime || !guestName.trim() || !guestEmail.trim()) {
    return res.status(400).json({ error: 'Startzeit, Name und E-Mail-Adresse sind erforderlich' });
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return res.status(400).json({ error: 'Ungültige Notiz' });
  }
  const name = guestName.trim();
  const email = guestEmail.trim();
  const note = notes ? notes.trim() : '';
  if (name.length > MAX_GUEST_NAME || email.length > MAX_GUEST_EMAIL || !EMAIL_RE.test(email) || note.length > MAX_NOTES) {
    return res.status(400).json({ error: 'Name, E-Mail-Adresse oder Notiz sind ungültig' });
  }
  const dateStr = startTime.split('T')[0];
  if (isNaN(new Date(startTime).getTime()) || !isValidDate(dateStr)) {
    return res.status(400).json({ error: 'Ungültige Startzeit' });
  }
  req.booking = { startTime, dateStr, guestName: name, guestEmail: email, notes: note };
  next();
}

function getUserIdFromReq(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  return null;
}

// ── Authenticated Routes ───────────────────────────────────────────────────

// GET /api/availability-slots - List availability booking pages
router.get('/availability-slots', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    const pages = await Db.getAvailabilityPages(userId);
    res.json(pages);
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/availability-slots - Create a new availability booking page
router.post('/availability-slots', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    const { slug, title, calendarId } = req.body;
    if (!slug || !title || !calendarId) {
      return res.status(400).json({ error: 'Slug, Titel und Kalender-ID sind erforderlich' });
    }
    let settings;
    try {
      settings = parseBookingSettings(req.body);
    } catch (err) {
      if (err instanceof BookingSettingsError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const busyCalendarIds = req.body.busyCalendarIds === undefined ? [] : req.body.busyCalendarIds;
    if (!Array.isArray(busyCalendarIds) || busyCalendarIds.length > MAX_BUSY_CALENDARS ||
        !busyCalendarIds.every(id => typeof id === 'string' && id)) {
      return res.status(400).json({ error: `Belegt-Kalender müssen eine Liste von höchstens ${MAX_BUSY_CALENDARS} Kalender-IDs sein` });
    }

    // The page books into calendarId, so the caller needs write access to it.
    // Any denial is reported as 404 so foreign calendar ids cannot be probed.
    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(404).json({ error: 'Kalender nicht gefunden' });
    }
    // The page reads busy time from these calendars on the owner's behalf.
    for (const busyId of busyCalendarIds) {
      const busyAccess = await checkCalendarAccess(req, busyId, 'read');
      if (!busyAccess.allowed) {
        return res.status(404).json({ error: 'Kalender nicht gefunden' });
      }
    }

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const existing = await Db.getAvailabilityPageBySlug(cleanSlug);
    if (existing) {
      return res.status(409).json({ error: 'Slug wird bereits verwendet' });
    }

    const page = await Db.createAvailabilityPage({
      userId,
      slug: cleanSlug,
      title: title.trim(),
      calendarId,
      ...settings,
      busyCalendarIds: [...new Set(busyCalendarIds)].filter(id => id !== calendarId)
    });

    res.status(201).json(page);
  } catch (err) {
    return sendError(res, err);
  }
});

// DELETE /api/availability-slots/:id - Delete an availability booking page
router.delete('/availability-slots/:id', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    await Db.deleteAvailabilityPage(req.params.id, userId);
    res.json({ success: true });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── Public Routes ──────────────────────────────────────────────────────────

// GET /api/public/availability/:slug - Public page details & available slots for date
router.get('/public/availability/:slug', async (req, res) => {
  try {
    const page = await Db.getAvailabilityPageBySlug(req.params.slug);
    if (!page) {
      return res.status(404).json({ error: 'Buchungsseite nicht gefunden' });
    }

    const dateStr = req.query.date || new Date().toISOString().split('T')[0];
    if (!isValidDate(dateStr)) {
      return res.status(400).json({ error: 'Ungültiges Datum' });
    }
    const availableSlots = await freeSlotsFor(page, dateStr, { cached: true });

    res.json({
      id: page.id,
      slug: page.slug,
      title: page.title,
      durationMinutes: page.durationMinutes,
      date: dateStr,
      availableSlots
    });
  } catch (err) {
    if (err instanceof ReadBudgetExhausted) {
      res.setHeader('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: TOO_MANY_REQUESTS });
    }
    return sendError(res, err);
  }
});

// POST /api/public/availability/:slug/book - Book a specific slot
router.post('/public/availability/:slug/book', bookingIpLimiter, validateBooking, bookingPageLimiter, async (req, res) => {
  try {
    const page = await Db.getAvailabilityPageBySlug(req.params.slug);
    if (!page) {
      return res.status(404).json({ error: 'Buchungsseite nicht gefunden' });
    }

    const { startTime, dateStr, guestName: name, guestEmail: email, notes: note } = req.booking;
    const durationMs = (page.durationMinutes || 30) * 60 * 1000;
    const endTime = new Date(new Date(startTime).getTime() + durationMs).toISOString();

    const booking = await serializeForOwner(page.userId, async () => {
      const freeSlots = await freeSlotsFor(page, dateStr);
      if (!freeSlots.some(s => s.startTime === startTime)) return null;

      const event = await createBookingEvent(page, { startTime, endTime, guestName: name, guestEmail: email, notes: note });
      dropCachedSlotsOfOwner(page.userId);
      try {
        return await Db.createSlotBooking({
          pageId: page.id,
          guestName: name,
          guestEmail: email,
          startTime,
          endTime,
          notes: note,
          eventUid: event.uid
        });
      } catch (dbErr) {
        // No booking without its event and no event without its booking.
        await event.remove().catch(removeErr => {
          console.error(`[availability book] Orphaned booking event ${event.uid} could not be removed:`, removeErr.message);
        });
        throw dbErr;
      }
    });

    if (!booking) {
      return res.status(409).json({ error: 'Der gewählte Zeitslot ist nicht mehr verfügbar' });
    }
    await queueSyncForCalendar(page.calendarId, page.userId);

    res.status(201).json({
      bookingId: booking.id,
      message: 'Zeitslot erfolgreich gebucht',
      booking
    });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
