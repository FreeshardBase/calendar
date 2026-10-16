'use strict';

/**
 * Issue #57 — HIGH: NODE_TLS_REJECT_UNAUTHORIZED=0 set process-wide
 *
 * Verifies:
 *   1. The booted production server reaches the self-signed internal Radicale (with
 *      Accept-Encoding: identity) but keeps full TLS verification for every other CalDAV host,
 *      so nothing disables verification process-wide.
 *   2. getInternalDispatcher() returns an undici Agent with rejectUnauthorized: false for
 *      the internal Radicale URL, and dispatcherFor() undefined for external URLs (full TLS).
 *   3. docker-compose.yml does not set NODE_TLS_REJECT_UNAUTHORIZED.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createTestCertificate } = require('./helpers/testTls');
const { bootProductionServer, TERMINAL } = require('./helpers/productionServer');

const ROOT = path.join(__dirname, '../..');
const SERVER_DIR = path.join(ROOT, 'server');

// ── Test 1: the production server skips verification for internal Radicale only ─

// A CalDAV backend with a self-signed certificate that records what reaches it.
async function selfSignedCalDAV(t, cert) {
  const requests = [];
  const server = https.createServer(cert, (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"/>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `https://127.0.0.1:${server.address().port}`, requests };
}

test('production server reaches the self-signed internal Radicale, but refuses a self-signed external CalDAV host', async (t) => {
  const cert = createTestCertificate();
  const internal = await selfSignedCalDAV(t, cert);
  const external = await selfSignedCalDAV(t, cert);
  const { base, stderr } = await bootProductionServer(t, {
    INTERNAL_CALDAV_URL: internal.url,
    CALDAVURL: `${external.url}/testuser/`,
    CALDAV_PASSWORD: 'testuser-external-password',
  });

  const session = await fetch(`${base}/api/auth/session`, { headers: TERMINAL });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  await fetch(`${base}/api/calendars`, { headers: { ...TERMINAL, cookie } });

  assert.ok(internal.requests.length > 0, `the internal Radicale must be reached despite its self-signed certificate; stderr: ${stderr()}`);
  for (const r of internal.requests) {
    assert.equal(r.headers['accept-encoding'], 'identity', `${r.method} ${r.url} must ask Radicale for identity encoding`);
  }
  assert.deepEqual(external.requests, [], 'TLS verification must stay on for every other host: no request may complete the handshake');
});

// ── Test 2: getInternalDispatcher returns an Agent for internal URLs ──────────

test('getInternalDispatcher() returns an undici Agent instance', () => {
  const { getInternalDispatcher } = require(path.join(SERVER_DIR, 'utils', 'tlsDispatcher.js'));
  const dispatcher = getInternalDispatcher();
  assert.ok(dispatcher !== undefined, 'getInternalDispatcher() must return a dispatcher');
  assert.strictEqual(typeof dispatcher.dispatch, 'function', 'returned dispatcher must have dispatch()');
});

// ── Test 3: isInternalUrl correctly classifies URLs ──────────────────────────

test('isInternalUrl() correctly identifies internal Radicale URLs', () => {
  const { isInternalUrl } = require(path.join(SERVER_DIR, 'utils', 'tlsDispatcher.js'));

  const origInternalUrl = process.env.INTERNAL_CALDAV_URL;
  process.env.INTERNAL_CALDAV_URL = 'https://localhost:5232';

  assert.strictEqual(isInternalUrl('https://localhost:5232/user/calendar/'), true,
    'localhost:5232 must be classified as internal');
  assert.strictEqual(isInternalUrl('https://localhost:5232'), true,
    'bare internal URL must be classified as internal');
  assert.strictEqual(isInternalUrl('https://apidata.googleusercontent.com/caldav/v2/'), false,
    'Google CalDAV must NOT be classified as internal');
  assert.strictEqual(isInternalUrl('https://caldav.example.com/'), false,
    'external CalDAV must NOT be classified as internal');
  assert.strictEqual(isInternalUrl('http://localhost:5232/test/'), true,
    'http scheme internal URL must be classified as internal');

  if (origInternalUrl === undefined) {
    delete process.env.INTERNAL_CALDAV_URL;
  } else {
    process.env.INTERNAL_CALDAV_URL = origInternalUrl;
  }
});

// ── Test 4: dispatcherFor() returns dispatcher only for internal URLs ─────────

test('dispatcherFor() returns dispatcher for internal URL, undefined for external', () => {
  const { dispatcherFor } = require(path.join(SERVER_DIR, 'utils', 'tlsDispatcher.js'));

  const origInternalUrl = process.env.INTERNAL_CALDAV_URL;
  process.env.INTERNAL_CALDAV_URL = 'https://localhost:5232';

  const internalDispatcher = dispatcherFor('https://localhost:5232/test/cal/event.ics');
  assert.ok(internalDispatcher !== undefined, 'internal URL must receive a dispatcher');
  assert.strictEqual(typeof internalDispatcher.dispatch, 'function',
    'internal dispatcher must be an undici Agent');

  const externalDispatcher = dispatcherFor('https://apidata.googleusercontent.com/caldav/v2/test/');
  assert.strictEqual(externalDispatcher, undefined,
    'external URL must receive undefined dispatcher (system default, full TLS)');

  if (origInternalUrl === undefined) {
    delete process.env.INTERNAL_CALDAV_URL;
  } else {
    process.env.INTERNAL_CALDAV_URL = origInternalUrl;
  }
});

// ── Test 5: docker-compose.yml must NOT set NODE_TLS_REJECT_UNAUTHORIZED=0 ──

test('docker-compose.yml must not set NODE_TLS_REJECT_UNAUTHORIZED: "0"', () => {
  const composePath = path.join(ROOT, 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    const composeSrc = fs.readFileSync(composePath, 'utf8');
    assert.ok(
      !composeSrc.includes('NODE_TLS_REJECT_UNAUTHORIZED'),
      'docker-compose.yml must not disable TLS verification globally'
    );
  }
});
