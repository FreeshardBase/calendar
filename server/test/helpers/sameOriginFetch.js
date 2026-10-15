'use strict';

/**
 * Issue #340 — the server refuses state-changing requests that do not come from its own
 * origin (server/utils/csrfGuard.js). A browser marks the app's own fetches with
 * `Sec-Fetch-Site: same-origin`; Node's fetch sends neither that nor Origin.
 *
 * Requiring this module makes the test process's fetch and http.request behave like the app's own frontend:
 * a POST/PUT/PATCH/DELETE without an explicit Origin or Sec-Fetch-Site gets
 * `Sec-Fetch-Site: same-origin`. A test that sets either header itself is left untouched, so
 * cross-origin cases stay expressible. The CSRF suite (issue340_csrf_origin_guard) does not
 * use this helper.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const nativeFetch = globalThis.fetch;

function sameOriginFetch(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (SAFE_METHODS.has(method)) return nativeFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has('origin') && !headers.has('sec-fetch-site')) {
    headers.set('sec-fetch-site', 'same-origin');
  }
  return nativeFetch(input, { ...init, headers });
}

if (!globalThis.fetch.__sameOrigin) {
  sameOriginFetch.__sameOrigin = true;
  globalThis.fetch = sameOriginFetch;
}

// The same for http.request([url,] options[, callback]) as used by the older suites.
const http = require('node:http');
const nativeRequest = http.request;

function withSameOrigin(options) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const names = Object.keys(headers).map((h) => h.toLowerCase());
  if (SAFE_METHODS.has(method) || names.includes('origin') || names.includes('sec-fetch-site')) return options;
  return { ...options, headers: { ...headers, 'Sec-Fetch-Site': 'same-origin' } };
}

function sameOriginRequest(...args) {
  const i = args.findIndex((a) => a && typeof a === 'object' && !(a instanceof URL));
  if (i !== -1 && i <= 1) args[i] = withSameOrigin(args[i]);
  return nativeRequest.apply(this, args);
}

if (!http.request.__sameOrigin) {
  sameOriginRequest.__sameOrigin = true;
  http.request = sameOriginRequest;
}
