'use strict';

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { evaluateWorkingHoursPolicy } = require('../utils/workingHoursPolicy');

// Helper to get session user ID
function getSessionUserId(req) {
  return req.session && req.session.userId ? req.session.userId : 'internal-user';
}

// GET /api/working-hours - Get user's working hours & OOO policy
router.get('/', async (req, res, next) => {
  try {
    const userId = getSessionUserId(req);
    const policy = await Db.getWorkingHoursPolicy(userId);
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// POST /api/working-hours - Save working hours & OOO policy
router.post('/', async (req, res, next) => {
  try {
    const userId = getSessionUserId(req);
    const {
      startHour,
      endHour,
      workDays,
      autoDecline,
      oooEnabled,
      oooStart,
      oooEnd,
      oooMessage
    } = req.body;

    const updated = await Db.upsertWorkingHoursPolicy(userId, {
      startHour,
      endHour,
      workDays,
      autoDecline,
      oooEnabled,
      oooStart,
      oooEnd,
      oooMessage
    });

    res.json({
      success: true,
      policy: updated
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/working-hours/evaluate - Evaluate an event time range against user policy
router.post('/evaluate', async (req, res, next) => {
  try {
    const userId = getSessionUserId(req);
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    const policy = await Db.getWorkingHoursPolicy(userId);
    const evaluation = evaluateWorkingHoursPolicy(startTime, endTime, policy);

    res.json({
      policy,
      ...evaluation
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
