'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { calculateFreeSlots } = require('../utils/availabilityBooking');
const { checkCalendarAccess } = require('../utils/calendarAuth');

function getUserIdFromReq(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  if (process.env.NODE_ENV === 'test' && req.headers && req.headers['x-test-user-id']) {
    return req.headers['x-test-user-id'];
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

    const { slug, title, calendarId, durationMinutes, startHour, endHour, daysOfWeek } = req.body;
    if (!slug || !title || !calendarId) {
      return res.status(400).json({ error: 'Slug, Titel und Kalender-ID sind erforderlich' });
    }

    // The page books into calendarId, so the caller needs write access to it.
    // Any denial is reported as 404 so foreign calendar ids cannot be probed.
    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(404).json({ error: 'Kalender nicht gefunden' });
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
      durationMinutes: durationMinutes || 30,
      startHour: startHour !== undefined ? startHour : 9,
      endHour: endHour !== undefined ? endHour : 17,
      daysOfWeek: daysOfWeek || '1,2,3,4,5'
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
    const existingBookings = await Db.getSlotBookingsForPage(page.id, dateStr);
    const availableSlots = calculateFreeSlots(page, [], existingBookings, dateStr);

    res.json({
      id: page.id,
      slug: page.slug,
      title: page.title,
      durationMinutes: page.durationMinutes,
      date: dateStr,
      availableSlots
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/public/availability/:slug/book - Book a specific slot
router.post('/public/availability/:slug/book', async (req, res) => {
  try {
    const page = await Db.getAvailabilityPageBySlug(req.params.slug);
    if (!page) {
      return res.status(404).json({ error: 'Buchungsseite nicht gefunden' });
    }

    const { startTime, guestName, guestEmail, notes } = req.body;
    if (!startTime || !guestName || !guestEmail) {
      return res.status(400).json({ error: 'Startzeit, Name und E-Mail-Adresse sind erforderlich' });
    }

    const start = new Date(startTime);
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: 'Ungültige Startzeit' });
    }

    const durationMs = (page.durationMinutes || 30) * 60 * 1000;
    const end = new Date(start.getTime() + durationMs);
    const endTime = end.toISOString();
    const dateStr = startTime.split('T')[0];

    const existingBookings = await Db.getSlotBookingsForPage(page.id, dateStr);
    const freeSlots = calculateFreeSlots(page, [], existingBookings, dateStr);

    const isSlotAvailable = freeSlots.some(s => s.startTime === startTime);
    if (!isSlotAvailable) {
      return res.status(409).json({ error: 'Der gewählte Zeitslot ist nicht mehr verfügbar' });
    }

    const booking = await Db.createSlotBooking({
      pageId: page.id,
      guestName: guestName.trim(),
      guestEmail: guestEmail.trim(),
      startTime,
      endTime,
      notes: notes ? notes.trim() : ''
    });

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
