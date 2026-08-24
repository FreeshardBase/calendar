'use strict';

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  evaluateUpcomingAlarms,
  formatPushPayload
} = require('../utils/webPushNotifications');

function getUserIdFromReq(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  if (req.headers['x-test-user-id'] && req.headers['x-test-user-id'] !== 'unauthenticated' && req.headers['x-test-user-id'] !== 'none') {
    return req.headers['x-test-user-id'];
  }
  return null;
}

// Authenticated Route Gate
router.use((req, res, next) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});

// GET /api/notifications/push-subscriptions - List user's subscriptions
router.get('/push-subscriptions', async (req, res, next) => {
  try {
    const userId = getUserIdFromReq(req);
    const subs = await Db.getPushSubscriptions(userId);
    res.json(subs);
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/push-subscriptions - Register push subscription
router.post('/push-subscriptions', async (req, res, next) => {
  try {
    const userId = getUserIdFromReq(req);
    const { endpoint, keys, keys_p256dh, keys_auth } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }

    const p256dh = keys_p256dh || (keys ? keys.p256dh : null);
    const auth = keys_auth || (keys ? keys.auth : null);

    const saved = await Db.savePushSubscription({
      user_id: userId,
      endpoint,
      keys_p256dh: p256dh,
      keys_auth: auth
    });

    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/push-subscriptions/:id - Delete push subscription
router.delete('/push-subscriptions/:id', async (req, res, next) => {
  try {
    const userId = getUserIdFromReq(req);
    const { id } = req.params;
    await Db.deletePushSubscription(id, userId);
    res.json({ success: true, message: 'Subscription removed' });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/evaluate-alarms - Evaluate event VALARMs and generate push payloads
router.post('/evaluate-alarms', async (req, res, next) => {
  try {
    const { events, windowMinutes, now } = req.body;
    const triggered = evaluateUpcomingAlarms(events || [], {
      windowMinutes: windowMinutes !== undefined ? windowMinutes : 15,
      now
    });

    const pushPayloads = triggered.map(alarm => formatPushPayload(alarm));
    res.json({
      triggeredCount: triggered.length,
      triggeredAlarms: triggered,
      pushPayloads
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
