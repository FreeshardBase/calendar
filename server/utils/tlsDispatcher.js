'use strict';

/**
 * tlsDispatcher — Issue #57 fix
 *
 * Provides a per-request TLS dispatcher that disables certificate verification
 * ONLY for the internal Radicale CalDAV server (self-signed cert), while
 * keeping full TLS verification for all external hosts (Google, Nextcloud,
 * mailbox.org, etc.).
 *
 * Usage in fetch():
 *   const { dispatcherFor } = require('./tlsDispatcher');
 *   const res = await fetch(url, { dispatcher: dispatcherFor(url), ... });
 *
 * dispatcherFor() returns:
 *   - an undici Agent with rejectUnauthorized: false  → for INTERNAL_CALDAV_URL host
 *   - undefined                                       → for everything else (uses system default)
 */

const { Agent } = require('undici');

// Singleton agent reused across all internal requests.
let _internalAgent = null;

/**
 * Returns a cached undici Agent that skips TLS verification.
 * Only for use with the local, self-signed Radicale server.
 *
 * @returns {import('undici').Agent}
 */
function getInternalDispatcher() {
  if (!_internalAgent) {
    _internalAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _internalAgent;
}

/**
 * Returns true if the given URL targets the configured internal CalDAV server.
 *
 * Comparison is by host (hostname + port) so that path differences don't matter.
 * Falls back to 'localhost:5232' if INTERNAL_CALDAV_URL is unset.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isInternalUrl(url) {
  try {
    const internalBase = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
    const internalHost = new URL(internalBase).host;  // e.g. "localhost:5232"
    const targetHost   = new URL(url).host;
    return targetHost === internalHost;
  } catch {
    return false;
  }
}

/**
 * Returns the appropriate undici dispatcher for the given URL:
 *   - internal CalDAV host → rejectUnauthorized:false agent
 *   - everything else       → undefined  (global dispatcher, full TLS)
 *
 * @param {string} url
 * @returns {import('undici').Agent | undefined}
 */
function dispatcherFor(url) {
  return isInternalUrl(url) ? getInternalDispatcher() : undefined;
}

module.exports = { getInternalDispatcher, isInternalUrl, dispatcherFor };
