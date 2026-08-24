'use strict';

/**
 * Configuration constants for Issue #8 — public ICS subscription caching
 * and rate-limiting.
 *
 * All values are overridable via environment variables so operators can tune
 * them without a code change.
 */

/** How long a served ICS response is cached in the database (seconds). */
const ICS_CACHE_TTL_SECONDS = parseInt(process.env.ICS_CACHE_TTL_SECONDS, 10) || 300;

/** Maximum number of fetches allowed per token per rate-limit window. */
const ICS_RATE_LIMIT_MAX = parseInt(process.env.ICS_RATE_LIMIT_MAX, 10) || 60;

/** Rate-limit sliding window width in seconds. */
const ICS_RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.ICS_RATE_LIMIT_WINDOW_SECONDS, 10) || 3600;

module.exports = {
  ICS_CACHE_TTL_SECONDS,
  ICS_RATE_LIMIT_MAX,
  ICS_RATE_LIMIT_WINDOW_SECONDS,
};
