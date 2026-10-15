'use strict';
require('./helpers/sameOriginFetch');
// Issue #68 — POST /api/calendars/:id/delta-sync against a loopback CalDAV stub,
// with production semantics:
//   1. ctagChanged reports whether the collection changed since the token, not a constant.
//   2. A token the server rejects (DAV:valid-sync-token) is dropped and replaced by a full sync,
//      so the calendar recovers instead of failing on every later call.
//   3. Detached RECURRENCE-ID overrides of a changed resource are part of the delta.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue68-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue68.db');
process.env.ENCRYPTION_KEY = 'issue68-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const { parseSyncCollectionResponse } = require('../caldav/parser');
const Db = require('../db');

const CAL_PATH = '/testuser/cal/';
const CAL_ID = `acc::${CAL_PATH}`;

const SERIES_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:series-1',
  'SUMMARY:Weekly standup',
  'DTSTART:20260105T090000Z',
  'DTEND:20260105T093000Z',
  'RRULE:FREQ=WEEKLY;COUNT=10',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series-1',
  'RECURRENCE-ID:20260112T090000Z',
  'SUMMARY:Standup moved',
  'DTSTART:20260112T140000Z',
  'DTEND:20260112T143000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series-1',
  'RECURRENCE-ID:20260119T090000Z',
  'SUMMARY:Standup renamed',
  'DTSTART:20260119T090000Z',
  'DTEND:20260119T093000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

function multistatus(inner, token) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `${inner}<d:sync-token>${token}</d:sync-token></d:multistatus>`;
}

function changedResource(href, ics) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag>` +
    `<c:calendar-data>${ics}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const VALID_SYNC_TOKEN_ERROR = '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>';

function tokenOf(body) {
  const m = body.match(/<d:sync-token>([^<]*)<\/d:sync-token>/);
  return m ? m[1] : null;
}

// handler(token, body) -> { status, body }; records every token the app sent.
async function withStack(handler, fn) {
  const sentTokens = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const token = tokenOf(body);
      sentTokens.push(token);
      const out = handler(token, body);
      res.writeHead(out.status, { 'Content-Type': 'application/xml' });
      res.end(out.body);
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.address().port}/`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'testuser',
      accounts: [{ id: 'acc', authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const deltaSync = async (body = {}) => {
    const res = await fetch(`${base}/api/calendars/${encodeURIComponent(CAL_ID)}/delta-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(deltaSync, sentTokens);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

test.beforeEach(async () => {
  await Db.upsertCalendarSyncCache(CAL_ID, null, null);
});

test('Issue #68 — an empty delta against a known token reports ctagChanged: false', async () => {
  await withStack(
    () => ({ status: 207, body: multistatus('', 'tok-7') }),
    async (deltaSync) => {
      const res = await deltaSync({ syncToken: 'tok-7' });
      assert.equal(res.status, 200);
      assert.equal(res.body.syncToken, 'tok-7');
      assert.deepEqual(res.body.updated, []);
      assert.deepEqual(res.body.deleted, []);
      assert.equal(res.body.ctagChanged, false);
    }
  );
});

test('Issue #68 — a delta with a changed or deleted resource reports ctagChanged: true', async () => {
  await withStack(
    () => ({ status: 207, body: multistatus(changedResource(`${CAL_PATH}a.ics`, SERIES_ICS), 'tok-8') }),
    async (deltaSync) => {
      const res = await deltaSync({ syncToken: 'tok-7' });
      assert.equal(res.status, 200);
      assert.equal(res.body.ctagChanged, true);
    }
  );
  await withStack(
    () => ({ status: 207, body: multistatus(`<d:response><d:href>${CAL_PATH}gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`, 'tok-9') }),
    async (deltaSync) => {
      const res = await deltaSync({ syncToken: 'tok-8' });
      assert.deepEqual(res.body.deleted, [`${CAL_PATH}gone.ics`]);
      assert.equal(res.body.ctagChanged, true);
    }
  );
});

test('Issue #68 — an initial sync without a token reports ctagChanged: true', async () => {
  await withStack(
    () => ({ status: 207, body: multistatus('', 'tok-1') }),
    async (deltaSync) => {
      const res = await deltaSync({});
      assert.equal(res.status, 200);
      assert.equal(res.body.syncToken, 'tok-1');
      assert.equal(res.body.ctagChanged, true);
    }
  );
});

test('Issue #68 — a token rejected with 403 valid-sync-token falls back to a full sync and is never replayed', async () => {
  await Db.upsertCalendarSyncCache(CAL_ID, null, 'dead-token');
  await withStack(
    (token) => (token === 'dead-token'
      ? { status: 403, body: VALID_SYNC_TOKEN_ERROR }
      : { status: 207, body: multistatus(token ? '' : changedResource(`${CAL_PATH}a.ics`, SERIES_ICS), 'fresh-token') }),
    async (deltaSync, sentTokens) => {
      const first = await deltaSync({});
      assert.equal(first.status, 200);
      assert.equal(first.body.fallbackPerformed, true);
      assert.equal(first.body.ctagChanged, true);
      assert.equal(first.body.syncToken, 'fresh-token');
      assert.equal((await Db.getCalendarSyncCache(CAL_ID)).syncToken, 'fresh-token');

      const second = await deltaSync({});
      assert.equal(second.status, 200);
      assert.equal(second.body.fallbackPerformed, false);
      assert.equal(second.body.ctagChanged, false);
      assert.equal(sentTokens.filter(t => t === 'dead-token').length, 1, 'the rejected token was sent again');
    }
  );
});

test('Issue #68 — detached RECURRENCE-ID overrides of a changed resource are part of the delta', async () => {
  await withStack(
    () => ({ status: 207, body: multistatus(changedResource(`${CAL_PATH}a.ics`, SERIES_ICS), 'tok-8') }),
    async (deltaSync) => {
      const res = await deltaSync({ syncToken: 'tok-7' });
      assert.equal(res.status, 200);
      const titles = res.body.updated.map(e => e.title).sort();
      assert.deepEqual(titles, ['Standup moved', 'Standup renamed', 'Weekly standup']);
      const moved = res.body.updated.find(e => e.title === 'Standup moved');
      assert.equal(moved.start, '2026-01-12T14:00:00.000Z');
      assert.ok(moved.recurrenceId, 'override carries its RECURRENCE-ID');
      assert.ok(res.body.updated.every(e => e.href === `${CAL_PATH}a.ics`));
    }
  );
});

test('Issue #68 — parseSyncCollectionResponse returns master and every override of a resource', () => {
  const xml = multistatus(changedResource(`${CAL_PATH}a.ics`, SERIES_ICS), 'tok-99');
  const parsed = parseSyncCollectionResponse(xml, CAL_ID, 'acc', `http://127.0.0.1${CAL_PATH}`);
  assert.equal(parsed.updated.length, 3);
  const master = parsed.updated.find(e => !e.recurrenceId);
  assert.equal(master.title, 'Weekly standup');
  assert.equal(parsed.updated.filter(e => e.recurrenceId).length, 2);
});
