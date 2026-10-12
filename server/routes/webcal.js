'use strict';

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  normalizeWebcalUrl,
  fetchAndParseWebcalFeed
} = require('../utils/webcalSubscription');
const { assertPublicUrl } = require('../utils/outboundFetch');

function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  if (process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') {
    const headerUser = req.headers ? req.headers['x-test-user-id'] : null;
    if (headerUser && headerUser !== 'unauthenticated' && headerUser !== 'none') {
      return headerUser;
    }
  }
  return null;
}

/**
 * GET /api/webcal/subscriptions - List user's subscriptions
 */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const subscriptions = await Db.getWebcalSubscriptions(userId);
    res.json({ subscriptions });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/webcal/subscriptions - Create new webcal subscription
 */
router.post('/subscriptions', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { name, url, color, refreshInterval } = req.body || {};

    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }

    const normalizedUrl = normalizeWebcalUrl(url);
    // Issue #337: never store a subscription that points into the internal network.
    await assertPublicUrl(normalizedUrl);

    const subscription = await Db.createWebcalSubscription({
      userId,
      name,
      url: normalizedUrl,
      color,
      refreshInterval: refreshInterval || 3600
    });

    try {
      await fetchAndParseWebcalFeed(subscription);
    } catch (fetchErr) {
      console.warn(`[Webcal] Initial feed fetch for subscription ${subscription.id}:`, fetchErr.message);
    }

    const created = await Db.getWebcalSubscription(subscription.id, userId);
    res.status(201).json(created || subscription);
  } catch (err) {
    if (err.code === 'OUTBOUND_URL_BLOCKED') {
      return res.status(400).json({ error: 'Diese Adresse ist nicht erlaubt: interne oder private Netzwerkziele können nicht abonniert werden.' });
    }
    if (err.message.includes('Unsupported subscription URL protocol') || err.message.includes('Invalid URL format')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * GET /api/webcal/subscriptions/:id - Get single subscription details
 */
router.get('/subscriptions/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const subscription = await Db.getWebcalSubscription(req.params.id, userId);

    if (!subscription) {
      return res.status(404).json({ error: 'Webcal subscription not found' });
    }

    res.json(subscription);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/webcal/subscriptions/:id - Update subscription
 */
router.patch('/subscriptions/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { name, color, refreshInterval } = req.body || {};

    const updated = await Db.updateWebcalSubscription(req.params.id, userId, {
      name,
      color,
      refreshInterval
    });

    if (!updated) {
      return res.status(404).json({ error: 'Webcal subscription not found' });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/webcal/subscriptions/:id/events - Fetch and parse feed events
 */
router.get('/subscriptions/:id/events', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const subscription = await Db.getWebcalSubscription(req.params.id, userId);

    if (!subscription) {
      return res.status(404).json({ error: 'Webcal subscription not found' });
    }

    const force = req.query.force === 'true' || req.query.force === '1';
    const cached = await Db.getCachedWebcalEvents(req.params.id, userId);

    if (!force && cached && cached.length > 0) {
      return res.json({ events: cached });
    }

    const events = await fetchAndParseWebcalFeed(subscription);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/webcal/subscriptions/:id/sync - Trigger sync refresh
 */
router.post('/subscriptions/:id/sync', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const subscription = await Db.getWebcalSubscription(req.params.id, userId);

    if (!subscription) {
      return res.status(404).json({ error: 'Webcal subscription not found' });
    }

    const events = await fetchAndParseWebcalFeed(subscription);
    const updatedSub = await Db.getWebcalSubscription(req.params.id, userId);

    res.json({
      success: true,
      subscription: updatedSub,
      eventCount: events.length
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/webcal/subscriptions/:id - Delete subscription
 */
router.delete('/subscriptions/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const success = await Db.deleteWebcalSubscription(req.params.id, userId);

    if (!success) {
      return res.status(404).json({ error: 'Webcal subscription not found' });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
