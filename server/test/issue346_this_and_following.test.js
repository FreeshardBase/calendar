'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #346 — recurring events can be edited and deleted "this and following".
 *
 * PUT/DELETE /api/events/:uid with `scope: 'following'` splits the series at the chosen
 * occurrence: the stored series ends before it (RRULE UNTIL, in UTC for a zoned DTSTART), and on
 * edit a new series with its own UID starts at the occurrence, taking every EXDATE and override
 * from there on. Chosen at the first occurrence, the whole series is meant.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue346-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue346.db');
process.env.ENCRYPTION_KEY = 'issue346-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');
const { eventToICS, addOccurrenceException, upsertOccurrenceOverride, parseAndExpandEvent } = require('../utils/ical');

const USER = 'testuser';
const CAL = `internal-caldav::/${USER}/work/`;
const HREF = `/${USER}/work/weekly346.ics`;

// Weekly on Tuesdays 09:00 Berlin, six times from 2026-10-20 (across the DST change on 10-25),
// with an override on 10-27 (before the split), an EXDATE on 11-10 and a moved override on
// 11-17 (both after the split on 11-03).
function seriesIcs({ count = true } = {}) {
  let ics = eventToICS({
    uid: 'weekly346', title: 'Weekly sync',
    start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z',
    startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
    recurrence: count ? 'FREQ=WEEKLY;COUNT=6' : 'FREQ=WEEKLY',
  });
  ics = upsertOccurrenceOverride(ics, '2026-10-27T08:00:00Z', {
    title: 'Weekly sync (early)', start: '2026-10-27T07:00:00.000Z', end: '2026-10-27T08:00:00.000Z',
    startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
  });
  ics = addOccurrenceException(ics, '2026-11-10T08:00:00Z');
  ics = upsertOccurrenceOverride(ics, '2026-11-17T08:00:00Z', {
    title: 'Weekly sync (afternoon)', start: '2026-11-17T14:00:00.000Z', end: '2026-11-17T15:00:00.000Z',
    startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
  });
  return ics;
}

function davServer() {
  const store = new Map();
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = decodeURIComponent(req.url);
      const item = store.get(p);
      const ifMatch = req.headers['if-match'];
      if (ifMatch && (!item || item.etag !== ifMatch)) { res.writeHead(412); return res.end(); }
      if (req.method === 'GET') {
        if (!item) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: item.etag });
        return res.end(item.ics);
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && item) { res.writeHead(412); return res.end(); }
        counter += 1;
        const etag = `"e${counter}"`;
        store.set(p, { ics: body, etag });
        res.writeHead(item ? 204 : 201, { ETag: etag });
        return res.end();
      }
      if (req.method === 'DELETE') {
        if (!item) { res.writeHead(404); return res.end(); }
        store.delete(p);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  return { server, store };
}

async function withSetup(fn) {
  const shard = davServer();
  await new Promise((resolve) => shard.server.listen(0, '127.0.0.1', resolve));
  const accounts = [{
    id: 'internal-caldav', authType: 'basic', url: `http://127.0.0.1:${shard.server.address().port}/`,
    username: USER, password: 'testuser-password',
  }];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: USER, accounts }; next(); });
  app.use('/api/events', eventsRouter);
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn({ base: `http://127.0.0.1:${api.address().port}`, shard });
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => shard.server.close(resolve));
  }
}

function call(base, method, uid, body) {
  return fetch(`${base}/api/events/${encodeURIComponent(uid)}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const instances = (ics) => parseAndExpandEvent(ics, '2026-01-01T00:00:00Z', '2027-12-31T00:00:00Z')
  .map(e => ({ start: new Date(e.start).toISOString(), title: e.title, uid: e.masterUid || e.uid.split('::')[0] }))
  .sort((a, b) => a.start.localeCompare(b.start));

test('"this and following" edit splits the series: the old one ends before, a new one starts there', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: seriesIcs(), etag: '"s1"' });
    const res = await call(base, 'PUT', 'weekly346::2026-11-03T08:00:00Z', {
      calendarId: CAL, sourceCalendarId: CAL, href: HREF, etag: '"s1"',
      scope: 'following', recurrenceId: '2026-11-03T08:00:00Z',
      title: 'Weekly sync (new time)', allDay: false,
      // 10:00 Berlin from 11-03 on
      start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z',
      startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
      recurrence: 'FREQ=WEEKLY;COUNT=6',
    });
    assert.equal(res.status, 200, await res.clone().text());
    const saved = await res.json();

    assert.equal(shard.store.size, 2, 'the old series stays and a new resource is created');
    const head = shard.store.get(HREF).ics;
    assert.match(head, /RRULE:FREQ=WEEKLY;UNTIL=20261103T075959Z\r?\n/, 'UNTIL is UTC, just before the split');
    assert.doesNotMatch(head, /RRULE:FREQ=WEEKLY[^\r\n]*COUNT=/);
    assert.deepEqual(instances(head), [
      { start: '2026-10-20T07:00:00.000Z', title: 'Weekly sync', uid: 'weekly346' },
      { start: '2026-10-27T07:00:00.000Z', title: 'Weekly sync (early)', uid: 'weekly346' },
    ]);
    assert.doesNotMatch(head, /EXDATE/, 'the EXDATE after the split left the old series');
    assert.doesNotMatch(head, /afternoon/, 'the override after the split left the old series');

    const [tailPath] = [...shard.store.keys()].filter(k => k !== HREF);
    const tail = shard.store.get(tailPath).ics;
    assert.notEqual(saved.uid, 'weekly346');
    assert.equal(tailPath, `/${USER}/work/${saved.uid}.ics`);
    assert.equal(new URL(saved.href, base).pathname, tailPath);
    assert.doesNotMatch(tail, /UID:weekly346/, 'every component of the new series has the new UID');
    assert.match(tail, /RRULE:FREQ=WEEKLY;COUNT=4/, 'the new series has the remaining four of six');
    assert.deepEqual(instances(tail), [
      { start: '2026-11-03T09:00:00.000Z', title: 'Weekly sync (new time)', uid: saved.uid },
      { start: '2026-11-17T14:00:00.000Z', title: 'Weekly sync (afternoon)', uid: saved.uid },
      { start: '2026-11-24T09:00:00.000Z', title: 'Weekly sync (new time)', uid: saved.uid },
    ], '11-10 stays excluded and the moved 11-17 override keeps its time');
  });
});

test('"this and following" delete ends the series before the occurrence', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: seriesIcs({ count: false }), etag: '"s1"' });
    const res = await call(base, 'DELETE', 'weekly346::2026-11-03T08:00:00Z', {
      calendarId: CAL, href: HREF, etag: '"s1"', scope: 'following', recurrenceId: '2026-11-03T08:00:00Z',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(shard.store.size, 1, 'no new series on delete');
    const head = shard.store.get(HREF).ics;
    assert.deepEqual(instances(head).map(i => i.start), ['2026-10-20T07:00:00.000Z', '2026-10-27T07:00:00.000Z']);
    assert.doesNotMatch(head, /EXDATE|afternoon/);
  });
});

test('"this and following" from the first occurrence edits the whole series in place', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: seriesIcs(), etag: '"s1"' });
    const res = await call(base, 'PUT', 'weekly346::2026-10-20T07:00:00Z', {
      calendarId: CAL, sourceCalendarId: CAL, href: HREF, etag: '"s1"',
      scope: 'following', recurrenceId: '2026-10-20T07:00:00Z',
      title: 'Renamed', allDay: false,
      start: '2026-10-20T07:00:00.000Z', end: '2026-10-20T08:00:00.000Z',
      startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
      recurrence: 'FREQ=WEEKLY;COUNT=6',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual([...shard.store.keys()], [HREF]);
    const all = instances(shard.store.get(HREF).ics);
    assert.equal(all.length, 5);
    assert.equal(all[0].title, 'Renamed');
  });
});

test('a failed write of the old series removes the new one again', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: seriesIcs(), etag: '"s1"' });
    // The stored series changes after the client loaded it, but before the save writes it back.
    const origGet = shard.store.get.bind(shard.store);
    let reads = 0;
    shard.store.get = (k) => {
      const item = origGet(k);
      if (k !== HREF || !item || ++reads !== 2) return item;
      const changed = { ...item, etag: '"changed"' };
      shard.store.set(HREF, changed);
      return changed;
    };
    const res = await call(base, 'PUT', 'weekly346::2026-11-03T08:00:00Z', {
      calendarId: CAL, sourceCalendarId: CAL, href: HREF, etag: '"s1"',
      scope: 'following', recurrenceId: '2026-11-03T08:00:00Z',
      title: 'Weekly sync', allDay: false,
      start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z',
      startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
    });
    assert.equal(res.status, 409, await res.clone().text());
    assert.deepEqual([...shard.store.keys()], [HREF], 'the new series is removed again');
  });
});

test('a recurrenceId that is no occurrence of the series is refused', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: seriesIcs(), etag: '"s1"' });
    const res = await call(base, 'DELETE', 'weekly346::2026-11-04T08:00:00Z', {
      calendarId: CAL, href: HREF, etag: '"s1"', scope: 'following', recurrenceId: '2026-11-04T08:00:00Z',
    });
    assert.equal(res.status, 400);
    assert.equal(shard.store.get(HREF).etag, '"s1"', 'the series is untouched');
  });
});
