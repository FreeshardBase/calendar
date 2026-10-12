'use strict';

/**
 * outboundFetch — Issue #337
 *
 * Shared guard for every request to a user-supplied URL (account linking,
 * webcal subscriptions). On a shard the app container shares a network with
 * other apps and the platform, so user URLs must never reach loopback,
 * link-local, private, ULA or other non-public addresses.
 *
 *   - assertPublicUrl(url): http(s) only, rejects single-label / .local /
 *     .internal / .localhost names, IP literals in blocked ranges and hostnames
 *     whose DNS answers contain a blocked address.
 *   - getGuardedDispatcher(): undici Agent whose connect-time DNS lookup
 *     rejects blocked addresses again (no DNS-rebinding window between check
 *     and connect).
 *   - safeFetch(url, init, opts): manual redirects (each hop re-checked,
 *     capped), connect + total timeout.
 *   - readTextLimited(res, maxBytes): body size cap.
 *
 * OUTBOUND_FETCH_ALLOW_HOSTS (comma-separated hostnames) lets an operator
 * explicitly allow specific hosts, e.g. a CalDAV server on the home LAN.
 */

const dns = require('node:dns');
const net = require('node:net');
const { Agent } = require('undici');

const DEFAULT_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class OutboundUrlBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutboundUrlBlockedError';
    this.code = 'OUTBOUND_URL_BLOCKED';
  }
}

class ResponseTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Response exceeds the size limit of ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
    this.code = 'RESPONSE_TOO_LARGE';
  }
}

// Separate lists per family: a BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so one shared list would block all of IPv4.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],         // "this" network
  ['10.0.0.0', 8],        // private
  ['100.64.0.0', 10],     // carrier-grade NAT
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link-local, cloud metadata
  ['172.16.0.0', 12],     // private (Docker/Podman default bridges)
  ['192.0.0.0', 24],      // IETF protocol assignments
  ['192.0.2.0', 24],      // TEST-NET-1
  ['192.168.0.0', 16],    // private
  ['198.18.0.0', 15],     // benchmarking
  ['198.51.100.0', 24],   // TEST-NET-2
  ['203.0.113.0', 24],    // TEST-NET-3
  ['224.0.0.0', 4],       // multicast
  ['240.0.0.0', 4]        // reserved, broadcast
]) {
  BLOCKED_V4.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],            // unspecified
  ['::1', 128],           // loopback
  ['::ffff:0:0', 96],     // IPv4-mapped
  ['64:ff9b::', 96],      // NAT64 (embeds IPv4)
  ['100::', 64],          // discard
  ['2001:db8::', 32],     // documentation
  ['fc00::', 7],          // unique local
  ['fe80::', 10],         // link-local
  ['ff00::', 8]           // multicast
]) {
  BLOCKED_V6.addSubnet(prefix, bits, 'ipv6');
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(address, 'ipv6');
  return true;
}

function allowedHosts() {
  return new Set(
    (process.env.OUTBOUND_FETCH_ALLOW_HOSTS || '')
      .split(',')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function bareHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isInternalHostname(hostname) {
  if (!hostname.includes('.')) return true; // compose service names, "localhost"
  return /\.(localhost|local|internal|lan|home\.arpa)\.?$/.test(hostname);
}

/**
 * Throws OutboundUrlBlockedError unless `url` is an http(s) URL that resolves
 * only to public addresses (or its host is in OUTBOUND_FETCH_ALLOW_HOSTS).
 */
async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new OutboundUrlBlockedError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutboundUrlBlockedError(`Protocol not allowed: ${parsed.protocol}`);
  }
  const host = bareHostname(parsed.hostname);
  if (allowedHosts().has(host)) return;

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new OutboundUrlBlockedError(`Target address not allowed: ${host}`);
    }
    return;
  }
  if (isInternalHostname(host)) {
    throw new OutboundUrlBlockedError(`Internal hostname not allowed: ${host}`);
  }

  const answers = await dns.promises.lookup(host, { all: true, verbatim: true });
  const blocked = answers.find(a => isBlockedAddress(a.address));
  if (blocked) {
    throw new OutboundUrlBlockedError(`Host ${host} resolves to a non-public address`);
  }
}

// Connect-time lookup: re-validates whatever address the socket will use.
function guardedLookup(hostname, options, callback) {
  const host = bareHostname(hostname);
  dns.lookup(host, options, (err, address, family) => {
    if (err) return callback(err);
    if (allowedHosts().has(host)) return callback(null, address, family);
    const addresses = Array.isArray(address) ? address.map(a => a.address) : [address];
    const bad = addresses.find(isBlockedAddress);
    if (bad) {
      return callback(new OutboundUrlBlockedError(`Host ${host} resolves to a non-public address`));
    }
    return callback(null, address, family);
  });
}

let _guardedAgent = null;

function getGuardedDispatcher() {
  if (!_guardedAgent) {
    _guardedAgent = new Agent({
      connect: { lookup: guardedLookup, timeout: CONNECT_TIMEOUT_MS }
    });
  }
  return _guardedAgent;
}

/**
 * fetch() for user-supplied URLs. Follows at most `maxRedirects` redirects
 * itself, re-checking every hop; the whole exchange (including body reads)
 * is bounded by `timeoutMs`.
 */
async function safeFetch(url, init = {}, {
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = Number(process.env.OUTBOUND_FETCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(currentUrl);
    const res = await fetch(currentUrl, {
      ...init,
      signal,
      redirect: 'manual',
      dispatcher: getGuardedDispatcher()
    });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= maxRedirects) {
      throw new Error(`Too many redirects (max ${maxRedirects})`);
    }
    await res.body?.cancel();
    currentUrl = new URL(location, currentUrl).href;
  }
}

/** Reads a response body as UTF-8 text, failing once it exceeds maxBytes. */
async function readTextLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {
  OutboundUrlBlockedError,
  ResponseTooLargeError,
  isBlockedAddress,
  assertPublicUrl,
  getGuardedDispatcher,
  safeFetch,
  readTextLimited
};
