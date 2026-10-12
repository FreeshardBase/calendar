/**
 * safeUrl.js — single URL scheme allow-list shared by the browser and the server.
 *
 * HTML-escaping does not neutralise `javascript:` / `data:` URLs, so any URL
 * that comes from calendar data (ATTACH from invitations, imports, webcal
 * feeds, synced external calendars) must pass this check before it is
 * rendered as a link. Loaded as a classic script in the browser
 * (window.SafeUrl) and via require() on the server.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SafeUrl = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALLOWED_LINK_PROTOCOLS = Object.freeze(['http:', 'https:', 'mailto:']);

  /**
   * True only for absolute http:, https: or mailto: URLs. Relative and
   * protocol-relative URLs are rejected, as is everything unparseable.
   */
  function isSafeLinkUrl(value) {
    if (typeof value !== 'string' || !URL.canParse(value)) return false;
    return ALLOWED_LINK_PROTOCOLS.includes(new URL(value).protocol);
  }

  return { ALLOWED_LINK_PROTOCOLS, isSafeLinkUrl };
});
