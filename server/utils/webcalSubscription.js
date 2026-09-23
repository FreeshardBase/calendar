'use strict';

const ICAL = require('ical.js');
const Db = require('../db');
const { parseICSToEvent } = require('../caldav/parser');

/**
 * Normalizes webcal:// and webcal://http(s):// URLs to standard http/https URLs.
 * Throws an error for invalid/unsupported protocols.
 */
function normalizeWebcalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid URL parameter');
  }
  let trimmed = rawUrl.trim();
  if (trimmed.startsWith('webcal://http://')) {
    trimmed = 'http://' + trimmed.substring('webcal://http://'.length);
  } else if (trimmed.startsWith('webcal://https://')) {
    trimmed = 'https://' + trimmed.substring('webcal://https://'.length);
  } else if (trimmed.startsWith('webcal://')) {
    trimmed = 'https://' + trimmed.substring('webcal://'.length);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported subscription URL protocol: ${parsed.protocol}`);
    }
    return parsed.href;
  } catch (err) {
    if (err.message.includes('Unsupported subscription URL protocol')) {
      throw err;
    }
    throw new Error(`Invalid URL format: ${err.message}`);
  }
}

/**
 * Parses an iCalendar (.ics) string into an array of read-only event objects tagged with subscription metadata.
 */
function parseWebcalFeed(icsString, subscription = {}) {
  if (!icsString || typeof icsString !== 'string') {
    return [];
  }

  try {
    const jcal = ICAL.parse(icsString);
    const comp = new ICAL.Component(jcal);
    const vevents = comp.getAllSubcomponents('vevent');

    return vevents.map(vevent => {
      const eventComp = new ICAL.Event(vevent);
      const uid = eventComp.uid || (vevent.getFirstPropertyValue('uid') || `webcal-${Date.now()}-${Math.random().toString(36).substring(2)}`);
      const summary = eventComp.summary || (vevent.getFirstPropertyValue('summary') || 'Untitled Event');
      const description = eventComp.description || (vevent.getFirstPropertyValue('description') || '');
      const location = eventComp.location || (vevent.getFirstPropertyValue('location') || '');

      let start = null;
      let end = null;
      let allDay = false;

      if (eventComp.startDate) {
        start = eventComp.startDate.toJSDate().toISOString();
        allDay = eventComp.startDate.isDate;
      }
      if (eventComp.endDate) {
        end = eventComp.endDate.toJSDate().toISOString();
      }

      return {
        id: uid,
        uid,
        title: summary,
        description,
        location,
        start,
        end,
        allDay,
        readOnly: true,
        isSubscription: true,
        subscriptionId: subscription.id || null,
        subscriptionName: subscription.name || null,
        color: subscription.color || '#3b82f6'
      };
    });
  } catch (err) {
    // Fail fast / return empty array on invalid ical syntax
    return [];
  }
}

/**
 * Fetches an external webcal/ICS feed from subscription URL, parses events, and updates sync timestamp.
 */
async function fetchAndParseWebcalFeed(subscription) {
  if (!subscription || !subscription.url) {
    throw new Error('Subscription and valid URL required');
  }

  const targetUrl = normalizeWebcalUrl(subscription.url);
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'FreeShard-WebCalendar/1.0 (Webcal-Subscription-Worker)'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch webcal feed (HTTP ${response.status})`);
  }

  const icsText = await response.text();
  const events = parseWebcalFeed(icsText, subscription);
  const now = Math.floor(Date.now() / 1000);

  if (subscription.id) {
    await Db.updateWebcalSubscriptionSyncTime(subscription.id, now, JSON.stringify(events));
  }

  return events;
}

/**
 * Syncs all subscriptions that are due based on last_synced_at and refresh_interval.
 */
async function syncDueWebcalSubscriptions(referenceTime = Math.floor(Date.now() / 1000)) {
  const due = await Db.getWebcalSubscriptionsDueForSync(referenceTime);
  let syncedCount = 0;
  const errors = [];

  for (const sub of due) {
    try {
      await fetchAndParseWebcalFeed(sub);
      syncedCount++;
    } catch (err) {
      errors.push({ id: sub.id, error: err.message });
      console.error(`[WebcalSyncWorker] Failed to sync subscription ${sub.id}:`, err.message);
    }
  }

  return { totalDue: due.length, syncedCount, errors };
}

/**
 * Starts periodic background sync worker.
 */
function startWebcalSyncWorker(intervalMs = 60000) {
  let isRunning = false;

  const runSync = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await syncDueWebcalSubscriptions();
    } catch (err) {
      console.error('[WebcalSyncWorker] Periodic sync error:', err.message);
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(runSync, intervalMs);
  if (timer.unref) {
    timer.unref();
  }

  return {
    timer,
    stop: () => clearInterval(timer)
  };
}

module.exports = {
  normalizeWebcalUrl,
  parseWebcalFeed,
  fetchAndParseWebcalFeed,
  syncDueWebcalSubscriptions,
  startWebcalSyncWorker
};
