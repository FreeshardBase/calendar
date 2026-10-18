'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #571 — the server, not the client, decides whether a PUT moves an event.
 *
 * The calendar that stores the event is the collection its `href` lies in. A PUT whose
 * `calendarId` names another calendar without `sourceCalendarId` used to write the event back
 * into the href's calendar and answer 200, so the "move" silently did nothing. It is refused
 * with 409 now. A `sourceCalendarId` that is not the href's calendar is refused with 400.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue571-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue571.db');
process.env.ENCRYPTION_KEY = 'issue571-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const eventsRouter = require('../routes/events');

const USER = 'testuser';
const SOURCE = `internal-caldav::/${USER}/test2/`;
const TARGET = `internal-caldav::/${USER}/Pers%C3%B6nlich/`;
const LINKED = 'testuser-linked::/cal/google/';
// A linked calendar deeper than /a/b/, as Google's /caldav/v2/<id>/events/.
const DEEP = 'testuser-linked::/caldav/v2/testuser%40example.com/events/';
const HREF = `/${USER}/test2/evt571.ics`;

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:evt571\r\n'
  + 'DTSTAMP:20261001T000000Z\r\nSUMMARY:original\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n'
  + 'END:VEVENT\r\nEND:VCALENDAR\r\n';

// An in-memory CalDAV server: path → { ics, etag }, honouring If-Match / If-None-Match.
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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

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

function put(base, body) {
  return fetch(`${base}/api/events/evt571`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'renamed', start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z', allDay: false, ...body,
    }),
  });
}

test('another calendarId without sourceCalendarId is refused, not written back into the old calendar', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: ICS, etag: '"s1"' });
    const res = await put(base, { calendarId: TARGET, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 409, await res.clone().text());
    assert.match((await res.json()).error, /sourceCalendarId/);
    assert.equal(shard.store.get(HREF).ics, ICS, 'the stored event is untouched');
    assert.equal(shard.store.size, 1, 'nothing is created in the target calendar');
  });
});

test('another calendarId in a linked account without sourceCalendarId is refused', async () => {
  await withSetup(async ({ base, shard, linked }) => {
    shard.store.set(HREF, { ics: ICS, etag: '"s1"' });
    const res = await put(base, { calendarId: LINKED, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal(shard.store.get(HREF).ics, ICS);
    assert.equal(linked.store.size, 0, 'nothing is written into the linked account');
  });
});

test('a sourceCalendarId that is not the calendar of href is refused with 400', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: ICS, etag: '"s1"' });
    // Claims to edit in place in the target, while href names test2.
    let res = await put(base, { calendarId: TARGET, sourceCalendarId: TARGET, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 400, await res.clone().text());
    // Claims to move from the linked calendar, while href names test2.
    res = await put(base, { calendarId: TARGET, sourceCalendarId: LINKED, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 400, await res.clone().text());
    assert.equal(shard.store.get(HREF).ics, ICS);
    assert.equal(shard.store.size, 1);
  });
});

test('an edit in place still saves, with or without sourceCalendarId, also in a deep linked calendar', async () => {
  await withSetup(async ({ base, shard, linked }) => {
    shard.store.set(HREF, { ics: ICS, etag: '"s1"' });
    let res = await put(base, { calendarId: SOURCE, sourceCalendarId: SOURCE, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(shard.store.get(HREF).ics, /SUMMARY:renamed/);

    const deepHref = '/caldav/v2/testuser%40example.com/events/evt571.ics';
    linked.store.set(decodeURIComponent(deepHref), { ics: ICS, etag: '"d1"' });
    res = await put(base, { calendarId: DEEP, href: deepHref, etag: '"d1"' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(linked.store.get(decodeURIComponent(deepHref)).ics, /SUMMARY:renamed/);
  });
});

test('the move with sourceCalendarId still lands in the target calendar', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(HREF, { ics: ICS, etag: '"s1"' });
    const res = await put(base, { calendarId: TARGET, sourceCalendarId: SOURCE, href: HREF, etag: '"s1"' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(shard.store.has(HREF), false);
    assert.match(shard.store.get(`/${USER}/Persönlich/evt571.ics`).ics, /SUMMARY:renamed/);
  });
});
