'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  queryParticipantAvailability,
  findCommonFreeSlots,
  buildVFreeBusy,
  parseVFreeBusy
} = require('../utils/freebusyScheduler');

function getUserIdFromReq(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  return null;
}

// ── Authenticated Route Gate ───────────────────────────────────────────────
router.use((req, res, next) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});

// ── POST /api/freebusy/query ───────────────────────────────────────────────
router.post('/query', async (req, res) => {
  try {
    const { participants, startTime, endTime, excludeEventUid } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants array is required' });
    }
    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    const result = await queryParticipantAvailability({
      participants,
      startTime,
      endTime,
      excludeEventUid
    });

    res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

// ── POST /api/freebusy/find-slots ─────────────────────────────────────────
router.post('/find-slots', async (req, res) => {
  try {
    const { participants, startDate, endDate, durationMinutes, workHoursStart, workHoursEnd } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants array is required' });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const slots = await findCommonFreeSlots({
      participants,
      startDate,
      endDate,
      durationMinutes,
      workHoursStart,
      workHoursEnd
    });

    res.json({ slots, totalSlots: slots.length });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GET /api/freebusy/vfreebusy ───────────────────────────────────────────
router.get('/vfreebusy', async (req, res) => {
  try {
    const { user, startTime, endTime } = req.query;

    const organizerEmail = user || 'testuser@example.com';
    const startIso = startTime || new Date().toISOString();
    const endIso = endTime || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const queryRes = await queryParticipantAvailability({
      participants: [organizerEmail],
      startTime: startIso,
      endTime: endIso
    });

    const busySlots = queryRes.participants[0] ? queryRes.participants[0].busySlots : [];
    const icsContent = buildVFreeBusy({
      organizerEmail,
      startTime: startIso,
      endTime: endIso,
      busySlots
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="freebusy.ics"`);
    res.send(icsContent);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
