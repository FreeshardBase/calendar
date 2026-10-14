'use strict';

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  normalizeWebcalUrl,
  parseWebcalFeed,
  refreshWebcalFeed
} = require('../utils/webcalSubscription');
const { assertPublicUrl } = require('../utils/outboundFetch');

// #160: the refresh error itself (English, upstream detail) is logged, not sent.
const FEED_FETCH_FAILED = 'Der Kalender-Feed konnte nicht abgerufen werden.';

function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
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
      await refreshWebcalFeed(subscription);
    } catch (fetchErr) {
      // Recorded as last_error on the subscription; the sidebar shows it.
      console.warn(`[Webcal] Initial feed fetch for subscription ${subscription.id}:`, fetchErr.message);
    }

    const created = await Db.getWebcalSubscription(subscription.id, userId);
    res.status(201).json(created || subscription);
  } catch (err) {
    if (err.code === 'OUTBOUND_URL_BLOCKED') {
      return res.status(400).json({ error: 'Diese Adresse ist nicht erlaubt: interne oder private Netzwerkziele können nicht abonniert werden.' });
    }
    if (err.message.includes('Unsupported subscription URL protocol') || err.message.includes('Invalid URL format')) {
      console.warn('[Webcal] Rejected subscription URL:', err.message);
      return res.status(400).json({ error: 'Ungültige Abonnement-Adresse. Erlaubt sind http(s)- und webcal-Adressen.' });
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
 * GET /api/webcal/subscriptions/:id/events?start=&end= - Feed events expanded for the window
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

    const start = new Date(req.query.start);
    const end = new Date(req.query.end);
    if (!req.query.start || !req.query.end || isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
      return res.status(400).json({ error: 'Valid start and end query parameters are required' });
    }

    const force = req.query.force === 'true' || req.query.force === '1';
    let cachedIcs = await Db.getCachedWebcalIcs(req.params.id, userId);
    let refreshError = null;

    if (force || !cachedIcs) {
      try {
        await refreshWebcalFeed(subscription);
        cachedIcs = await Db.getCachedWebcalIcs(req.params.id, userId);
      } catch (err) {
        // #342: the failure is recorded on the subscription; keep serving the last good copy.
        console.warn(`[Webcal] Refresh failed for subscription ${req.params.id}:`, err.message);
        refreshError = FEED_FETCH_FAILED;
      }
    }

    if (!cachedIcs) {
      return res.status(502).json({ error: refreshError, events: [] });
    }

    const events = parseWebcalFeed(cachedIcs, subscription, start.toISOString(), end.toISOString());
    res.json(refreshError ? { events, error: refreshError } : { events });
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

    let eventCount;
    try {
      ({ eventCount } = await refreshWebcalFeed(subscription));
    } catch (err) {
      // #342: recorded as last_error; the cached feed is unchanged.
      console.warn(`[Webcal] Refresh failed for subscription ${req.params.id}:`, err.message);
      const failedSub = await Db.getWebcalSubscription(req.params.id, userId);
      return res.status(502).json({ success: false, error: FEED_FETCH_FAILED, subscription: failedSub });
    }
    const updatedSub = await Db.getWebcalSubscription(req.params.id, userId);

    res.json({
      success: true,
      subscription: updatedSub,
      eventCount
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
