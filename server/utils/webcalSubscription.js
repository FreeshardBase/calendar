'use strict';

const ICAL = require('ical.js');
const Db = require('../db');
const { expandCalendarInRange } = require('./ical');
const { safeFetch, readTextLimited } = require('./outboundFetch');

// Issue #337: cap for a single ICS feed download.
const MAX_FEED_BYTES = 10 * 1024 * 1024;

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
 * Checks that a downloaded feed is a usable iCalendar document and returns the
 * number of distinct events in it. Throws on anything else (HTML error pages,
 * empty or truncated bodies) so a bad response never replaces the cache (#342).
 */
function validateWebcalFeed(icsText) {
  if (!icsText || !icsText.trim()) {
    throw new Error('Feed response is empty');
  }
  if (!/END:VCALENDAR\s*$/i.test(icsText)) {
    throw new Error('Feed is not valid iCalendar: END:VCALENDAR missing (wrong content or truncated response)');
  }
  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(icsText));
  } catch (err) {
    throw new Error(`Feed is not valid iCalendar: ${err.message}`);
  }
  if (comp.name !== 'vcalendar') {
    throw new Error(`Feed is not valid iCalendar: root component is ${comp.name || 'missing'}`);
  }
  const uids = new Set();
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    const uid = vevent.getFirstPropertyValue('uid');
    if (!uid) throw new Error('Feed is not valid iCalendar: VEVENT without UID');
    if (!vevent.getFirstPropertyValue('dtstart')) {
      throw new Error(`Feed is not valid iCalendar: VEVENT ${uid} without DTSTART`);
    }
    uids.add(uid);
  }
  return uids.size;
}

/**
 * Expands a cached feed into read-only event objects for [rangeStart, rangeEnd],
 * including RRULE/RDATE/EXDATE occurrences and RECURRENCE-ID overrides, using the
 * same engine as CalDAV events (#342).
 */
function parseWebcalFeed(icsString, subscription, rangeStart, rangeEnd) {
  if (!rangeStart || !rangeEnd) {
    throw new Error('parseWebcalFeed requires a time range');
  }
  return expandCalendarInRange(icsString, rangeStart, rangeEnd).map(ev => ({
    id: ev.uid,
    uid: ev.uid,
    masterUid: ev.masterUid || ev.uid,
    recurrenceId: ev.recurrenceId || null,
    recurrence: ev.recurrence || null,
    title: ev.title,
    description: ev.description || '',
    location: ev.location || '',
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    readOnly: true,
    isSubscription: true,
    subscriptionId: subscription.id || null,
    subscriptionName: subscription.name || null,
    color: subscription.color || '#3b82f6'
  }));
}

/**
 * Fetches a subscription's feed and replaces the cache only if the feed is valid.
 * Any failure is recorded on the subscription (last_error) and rethrown; the last
 * good cached copy stays in place (#342).
 */
async function refreshWebcalFeed(subscription) {
  if (!subscription || !subscription.url) {
    throw new Error('Subscription and valid URL required');
  }

  try {
    const targetUrl = normalizeWebcalUrl(subscription.url);
    const response = await safeFetch(targetUrl, {
      headers: {
        'User-Agent': 'FreeShard-WebCalendar/1.0 (Webcal-Subscription-Worker)'
      }
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Failed to fetch webcal feed (HTTP ${response.status})`);
    }

    const icsText = await readTextLimited(response, MAX_FEED_BYTES);
    const eventCount = validateWebcalFeed(icsText);

    if (subscription.id) {
      await Db.storeWebcalFeed(subscription.id, Math.floor(Date.now() / 1000), icsText);
    }
    return { eventCount };
  } catch (err) {
    if (subscription.id) {
      await Db.recordWebcalSyncError(subscription.id, Math.floor(Date.now() / 1000), err.message);
    }
    throw err;
  }
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
      await refreshWebcalFeed(sub);
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
  validateWebcalFeed,
  parseWebcalFeed,
  refreshWebcalFeed,
  syncDueWebcalSubscriptions,
  startWebcalSyncWorker
};
