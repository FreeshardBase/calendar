'use strict';

/**
 * Issue #57 — HIGH: NODE_TLS_REJECT_UNAUTHORIZED=0 set process-wide
 *
 * Verifies:
 *   1. server/index.js does NOT set process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' globally.
 *   2. server/utils/tlsDispatcher.js exists and exports getInternalDispatcher().
 *   3. getInternalDispatcher() returns an undici Agent with rejectUnauthorized: false for
 *      the internal Radicale URL, and undefined for external URLs (full TLS).
 *   4. CalDAVClient._request passes the internal dispatcher only for INTERNAL_CALDAV_URL hosts.
 *   5. External CalDAV clients (e.g. Google) are constructed without the bypass dispatcher.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const SERVER_DIR = path.join(ROOT, 'server');

// ── Test 1: Global flag absent from server/index.js ──────────────────────────

test('server/index.js must not set NODE_TLS_REJECT_UNAUTHORIZED=0 globally', () => {
  const indexSrc = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  const lines = indexSrc.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/\/\/.*/, '').trim();
    assert.ok(
      !stripped.includes("NODE_TLS_REJECT_UNAUTHORIZED = '0'"),
      `index.js must not set NODE_TLS_REJECT_UNAUTHORIZED=0 globally. Offending line: "${line.trim()}"`
    );
  }
});

// ── Test 2: tlsDispatcher module exists ──────────────────────────────────────

test('server/utils/tlsDispatcher.js must exist', () => {
  const filePath = path.join(SERVER_DIR, 'utils', 'tlsDispatcher.js');
  assert.ok(fs.existsSync(filePath), 'server/utils/tlsDispatcher.js must exist');
});

// ── Test 3: getInternalDispatcher returns an Agent for internal URLs ──────────

test('getInternalDispatcher() returns an undici Agent instance', () => {
  const { getInternalDispatcher } = require(path.join(SERVER_DIR, 'utils', 'tlsDispatcher.js'));
  const dispatcher = getInternalDispatcher();
  assert.ok(dispatcher !== undefined, 'getInternalDispatcher() must return a dispatcher');
  assert.strictEqual(typeof dispatcher.dispatch, 'function', 'returned dispatcher must have dispatch()');
});

// ── Test 4: isInternalUrl correctly classifies URLs ──────────────────────────

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

// ── Test 5: dispatcherFor() returns dispatcher only for internal URLs ─────────

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

// ── Test 6: CalDAVClient source references tlsDispatcher ─────────────────────

test('CalDAVClient source references tlsDispatcher for per-request dispatcher injection', () => {
  const clientSrc = fs.readFileSync(
    path.join(SERVER_DIR, 'caldav', 'client.js'), 'utf8'
  );
  assert.ok(
    clientSrc.includes('tlsDispatcher') || clientSrc.includes('dispatcherFor'),
    'CalDAVClient must import/use tlsDispatcher or dispatcherFor'
  );
  assert.ok(
    clientSrc.includes('dispatcher'),
    'CalDAVClient._request must pass dispatcher option to fetch()'
  );
});

// ── Test 7: docker-compose.yml must NOT set NODE_TLS_REJECT_UNAUTHORIZED=0 ──

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
