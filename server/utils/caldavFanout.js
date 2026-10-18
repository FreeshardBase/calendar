'use strict';

// #498: a request that reads every collection of an account (tasks, events, invitations) sends one
// REPORT per collection. Sent all at once, Radicale drops connections from about 60-100 of them on
// ("fetch failed"), and the request then lacks those collections. At most this many run at a time;
// against Radicale 4 was also faster than 8 or unbounded.
const CALDAV_REPORT_CONCURRENCY = 4;

/**
 * Runs `fn(item)` for every item with at most `limit` calls pending at once. Resolves when all have
 * settled; the first rejection rejects the whole run (callers handle per-item failures in `fn`).
 */
async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

module.exports = { CALDAV_REPORT_CONCURRENCY, forEachLimited };
