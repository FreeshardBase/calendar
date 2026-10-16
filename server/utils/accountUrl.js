'use strict';

// Issue #248: one CalDAV server can be spelled many ways (base domain vs. calendar
// home, trailing slash, host case, default port, %-escapes). Linked accounts are
// stored and compared in one canonical spelling so a second spelling of the same
// server is recognised as the account that already exists.

const UNRESERVED = /[A-Za-z0-9\-._~]/;

function normalizePercentEncoding(path) {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/**
 * Canonical form of a CalDAV account URL: lowercase scheme and host, default port
 * elided, dot segments resolved, unreserved %-escapes decoded (others uppercased),
 * path ending in "/", no fragment. Throws on anything that is not an http(s) URL.
 */
function canonicalAccountUrl(input) {
  const u = new URL(input);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Not an http(s) URL: ${input}`);
  }
  let path = normalizePercentEncoding(u.pathname);
  if (!path.endsWith('/')) path += '/';
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Two account URLs name the same account when one canonical URL is a
 * path-segment prefix of the other (same origin; "/" vs "/test/" overlap,
 * "/a/" vs "/b/" do not).
 */
function sameAccountUrl(a, b) {
  const ca = canonicalAccountUrl(a);
  const cb = canonicalAccountUrl(b);
  return ca.startsWith(cb) || cb.startsWith(ca);
}

module.exports = { canonicalAccountUrl, sameAccountUrl };
