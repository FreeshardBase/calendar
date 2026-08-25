'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3117';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server: appServer } = require('../index');

function baseUrl() {
  return `http://localhost:${process.env.PORT}`;
}

async function get(path, headers = {}) {
  return fetch(`${baseUrl()}${path}`, { headers });
}

describe('Issue #8 — Public ICS Subscription Caching & Rate-Limiting', () => {
  const token = 'test-ics-cache-token-8';

  before(async () => {
    await new Promise(r => setTimeout(r, 200));
    // Note: addCalendarShare auto-generates a token; we seed the test row directly.
    await new Promise((resolve, reject) => {
      const db = require('sqlite3').verbose();
      const path = require('path');
      const d = new db.Database(process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'webcalendar.db'));
      d.run("INSERT OR REPLACE INTO calendar_shares (token, calendar_id, label, created_at) VALUES (?, ?, ?, ?)",
        [token, 'internal-caldav::/testuser/personal/', 'Test ICS Feed', Date.now()],
        (err) => { d.close(); err ? reject(err) : resolve(); });
    });
  });

  after(() => {
    if (appServer && appServer.close) appServer.close();
  });

  // ── DB helpers ─────────────────────────────────────────────────────────────

  test('getIcsCache returns null when no entry exists', async () => {
    const entry = await Db.getIcsCache('nonexistent-token-xyz');
    assert.equal(entry, null);
  });

  test('upsertIcsCache stores and getIcsCache retrieves content', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    await Db.upsertIcsCache(token, ics, 300);

    const entry = await Db.getIcsCache(token);
    assert.ok(entry !== null);
    assert.equal(entry.token, token);
    assert.equal(entry.body, ics);
    assert.ok(typeof entry.expires_at === 'number');
    assert.ok(entry.expires_at > Date.now());
  });

  test('getIcsCache returns null for an expired entry', async () => {
    const expiredToken = 'expired-token-xyz-8';
    const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    await Db.upsertIcsCache(expiredToken, ics, 0);
    await new Promise(r => setTimeout(r, 20));
    const entry = await Db.getIcsCache(expiredToken);
    assert.equal(entry, null);
  });

  test('recordIcsFetch increments hit count for token', async () => {
    const rateToken = 'rate-test-token-8';
    await Db.recordIcsFetch(rateToken);
    await Db.recordIcsFetch(rateToken);
    const count = await Db.getIcsFetchCount(rateToken, 60);
    assert.ok(count >= 2);
  });

  test('getIcsFetchCount returns 0 for unknown token', async () => {
    const count = await Db.getIcsFetchCount('nobody-fetched-this-ever', 60);
    assert.equal(count, 0);
  });

  // ── HTTP ───────────────────────────────────────────────────────────────────

  test('GET /api/public/calendars/share/unknowntoken.ics returns 404', async () => {
    const res = await get('/api/public/calendars/share/completely-invalid-token.ics');
    assert.equal(res.status, 404);
  });

  test('Saturated rate-limit counter exceeds ICS_RATE_LIMIT_MAX', async () => {
    const limitToken = 'rl-test-token-99';
    const LIMIT = 60;
    const promises = [];
    for (let i = 0; i < LIMIT + 5; i++) {
      promises.push(Db.recordIcsFetch(limitToken));
    }
    await Promise.all(promises);

    const count = await Db.getIcsFetchCount(limitToken, 3600);
    assert.ok(count > LIMIT, `expected count > ${LIMIT}, got ${count}`);
  });

  test('Cache config constants are sane', async () => {
    const { ICS_CACHE_TTL_SECONDS, ICS_RATE_LIMIT_MAX, ICS_RATE_LIMIT_WINDOW_SECONDS } =
      require('../utils/icsPublicShareCache');
    assert.ok(ICS_CACHE_TTL_SECONDS >= 60);
    assert.ok(ICS_RATE_LIMIT_MAX >= 10);
    assert.ok(ICS_RATE_LIMIT_WINDOW_SECONDS >= 60);
  });

  test('upsertIcsCache overwrites stale entry on re-fetch', async () => {
    const refreshToken = 'refresh-cache-token-8';
    const ics1 = 'BEGIN:VCALENDAR\r\nPRODID:v1\r\nEND:VCALENDAR\r\n';
    const ics2 = 'BEGIN:VCALENDAR\r\nPRODID:v2\r\nEND:VCALENDAR\r\n';
    await Db.upsertIcsCache(refreshToken, ics1, 300);
    await Db.upsertIcsCache(refreshToken, ics2, 300);
    const entry = await Db.getIcsCache(refreshToken);
    assert.equal(entry.body, ics2);
  });
});
