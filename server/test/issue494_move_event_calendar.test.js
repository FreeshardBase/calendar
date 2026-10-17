'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #494 — changing an event's calendar in the edit dialog moves it.
 *
 * PUT /api/events/:uid with `sourceCalendarId` (where the event is stored) different from
 * `calendarId` (the calendar picked in the dialog) creates the event in the target collection
 * under the same UID and only then deletes it from the source. A failure on either step leaves
 * the event where it was and is reported. A series moves with its exceptions.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue494-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue494.db');
process.env.ENCRYPTION_KEY = 'issue494-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
// The linked account's fake CalDAV server runs on loopback, which the outbound guard refuses otherwise.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');

const USER = 'testuser';
const SHARD_SOURCE = `internal-caldav::/${USER}/test2/`;
const SHARD_TARGET = `internal-caldav::/${USER}/other/`;
const LINKED = 'testuser-linked::/cal/google/';

const SINGLE_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:evt494\r\n'
  + 'DTSTAMP:20261001T000000Z\r\nSUMMARY:safdsaf\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n'
  + 'END:VEVENT\r\nEND:VCALENDAR\r\n';

const SERIES_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n'
  + 'BEGIN:VEVENT\r\nUID:evt494\r\nDTSTAMP:20261001T000000Z\r\nSUMMARY:Weekly\r\n'
  + 'DTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\n'
  + 'EXDATE:20261103T090000Z\r\nEND:VEVENT\r\n'
  + 'BEGIN:VEVENT\r\nUID:evt494\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID:20261027T090000Z\r\n'
  + 'SUMMARY:Weekly moved exception\r\nDTSTART:20261027T140000Z\r\nDTEND:20261027T150000Z\r\nEND:VEVENT\r\n'
  + 'END:VCALENDAR\r\n';

// An in-memory CalDAV server: path → { ics, etag }, honouring If-Match / If-None-Match.
// `fail` makes requests whose "METHOD path" starts with one of its entries answer 500.
function davServer() {
  const store = new Map();
  const fail = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = decodeURIComponent(req.url);
      if (fail.some((f) => `${req.method} ${p}`.startsWith(f))) {
        res.writeHead(500);
        return res.end();
      }
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
  return { server, store, fail };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

// The shard's Radicale and a linked external account, each its own server.
async function withSetup(fn) {
  const shard = davServer();
  const linked = davServer();
  const shardUrl = await listen(shard.server);
  const linkedUrl = await listen(linked.server);
  const accounts = [
    { id: 'internal-caldav', authType: 'basic', url: shardUrl, username: USER, password: 'testuser-password' },
    { id: 'testuser-linked', authType: 'basic', url: linkedUrl, username: USER, password: 'testuser-password' },
  ];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: USER, accounts }; next(); });
  app.use('/api/events', eventsRouter);
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn({ base: `http://127.0.0.1:${api.address().port}`, shard, linked });
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => shard.server.close(resolve));
    await new Promise((resolve) => linked.server.close(resolve));
  }
}

function put(base, uid, body) {
  return fetch(`${base}/api/events/${encodeURIComponent(uid)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function editBody(overrides) {
  return {
    title: 'safdsaf',
    start: '2026-10-20T09:00:00.000Z',
    end: '2026-10-20T10:00:00.000Z',
    allDay: false,
    ...overrides,
  };
}

test('a shard event moves to another shard calendar under the same UID', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SINGLE_ICS, etag: '"s1"' });
    const res = await put(base, 'evt494', editBody({
      calendarId: SHARD_TARGET, sourceCalendarId: SHARD_SOURCE,
      href: '/testuser/test2/evt494.ics', etag: '"s1"', title: 'safdsaf renamed',
    }));
    assert.equal(res.status, 200, await res.clone().text());
    const saved = await res.json();
    assert.equal(saved.calendarId, SHARD_TARGET);
    assert.equal(shard.store.has('/testuser/test2/evt494.ics'), false, 'the source copy is deleted');
    const moved = shard.store.get('/testuser/other/evt494.ics');
    assert.ok(moved, 'the event is created in the target calendar');
    assert.match(moved.ics, /UID:evt494/);
    assert.match(moved.ics, /SUMMARY:safdsaf renamed/);
    assert.equal(new URL(saved.href, base).pathname, '/testuser/other/evt494.ics');
  });
});

test('a shard event moves into a linked calendar and back', async () => {
  await withSetup(async ({ base, shard, linked }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SINGLE_ICS, etag: '"s1"' });
    let res = await put(base, 'evt494', editBody({
      calendarId: LINKED, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
    }));
    assert.equal(res.status, 200, await res.clone().text());
    let saved = await res.json();
    assert.equal(shard.store.has('/testuser/test2/evt494.ics'), false);
    assert.match(linked.store.get('/cal/google/evt494.ics').ics, /UID:evt494/);

    res = await put(base, 'evt494', editBody({
      calendarId: SHARD_SOURCE, sourceCalendarId: LINKED, href: saved.href, etag: saved.etag,
    }));
    assert.equal(res.status, 200, await res.clone().text());
    saved = await res.json();
    assert.equal(saved.calendarId, SHARD_SOURCE);
    assert.equal(linked.store.size, 0, 'the linked copy is deleted');
    assert.match(shard.store.get('/testuser/test2/evt494.ics').ics, /UID:evt494/);
  });
});

test('a series moves as a whole, with its exceptions and excluded dates', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SERIES_ICS, etag: '"s1"' });
    const res = await put(base, 'evt494::20261020T090000Z', editBody({
      calendarId: SHARD_TARGET, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
      title: 'Weekly', scope: 'series', recurrenceId: '20261020T090000Z',
      recurrence: 'FREQ=WEEKLY;COUNT=5',
    }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(shard.store.has('/testuser/test2/evt494.ics'), false);
    const moved = shard.store.get('/testuser/other/evt494.ics').ics;
    assert.match(moved, /RRULE:FREQ=WEEKLY/);
    assert.match(moved, /RECURRENCE-ID:20261027T090000Z/);
    assert.match(moved, /SUMMARY:Weekly moved exception/);
    assert.match(moved, /EXDATE:20261103T090000Z/);
  });
});

test('a failed create in the target leaves the event in the source and reports the failure', async () => {
  await withSetup(async ({ base, shard, linked }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SINGLE_ICS, etag: '"s1"' });
    linked.fail.push('PUT /cal/google/');
    const res = await put(base, 'evt494', editBody({
      calendarId: LINKED, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
      title: 'safdsaf renamed',
    }));
    assert.ok(res.status >= 400, `the move must fail, got ${res.status}`);
    assert.equal(shard.store.get('/testuser/test2/evt494.ics').ics, SINGLE_ICS, 'the source is untouched');
    assert.equal(linked.store.size, 0);
  });
});

test('a failed delete in the source removes the new copy again and reports the failure', async () => {
  await withSetup(async ({ base, shard, linked }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SINGLE_ICS, etag: '"s1"' });
    shard.fail.push('DELETE /testuser/test2/');
    const res = await put(base, 'evt494', editBody({
      calendarId: LINKED, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
      title: 'safdsaf renamed',
    }));
    assert.ok(res.status >= 400, `the move must fail, got ${res.status}`);
    assert.equal(shard.store.get('/testuser/test2/evt494.ics').ics, SINGLE_ICS, 'the source is untouched');
    assert.equal(linked.store.size, 0, 'the copy in the target is removed again');
  });
});

test('an event the target already holds under its UID is not overwritten', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SINGLE_ICS, etag: '"s1"' });
    shard.store.set('/testuser/other/evt494.ics', { ics: 'OTHER', etag: '"o1"' });
    const res = await put(base, 'evt494', editBody({
      calendarId: SHARD_TARGET, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
    }));
    assert.equal(res.status, 409);
    assert.equal(shard.store.get('/testuser/other/evt494.ics').ics, 'OTHER');
    assert.equal(shard.store.get('/testuser/test2/evt494.ics').ics, SINGLE_ICS);
  });
});

test('a single occurrence is not moved on its own', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set('/testuser/test2/evt494.ics', { ics: SERIES_ICS, etag: '"s1"' });
    const res = await put(base, 'evt494::20261020T090000Z', editBody({
      calendarId: SHARD_TARGET, sourceCalendarId: SHARD_SOURCE, href: '/testuser/test2/evt494.ics', etag: '"s1"',
      scope: 'occurrence', recurrenceId: '20261020T090000Z',
    }));
    assert.equal(res.status, 400);
    assert.equal(shard.store.get('/testuser/test2/evt494.ics').ics, SERIES_ICS);
    assert.equal(shard.store.has('/testuser/other/evt494.ics'), false);
  });
});
