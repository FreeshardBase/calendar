'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #495 — tasks only go into collections that hold VTODO, and move like events.
 *
 * A collection whose supported-calendar-component-set lacks VTODO (the local mirror of a Google
 * calendar: Google's CalDAV has no tasks) refuses every task write with a clear error, although
 * Radicale itself would store it. PUT /api/tasks/:uid with `sourceCalendarId` (where the task is
 * stored) different from `calendarId` moves the task: created in the target under the same UID,
 * only then deleted from the source. A task stranded in a non-VTODO collection can be moved out.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue495-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue495.db');
process.env.ENCRYPTION_KEY = 'issue495-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const tasksRouter = require('../routes/tasks');

const USER = 'testuser';
const LIST = `internal-caldav::/${USER}/aufgaben/`;
const OTHER_LIST = `internal-caldav::/${USER}/privat/`;
const GOOGLE = `internal-caldav::/${USER}/google-0123456789abcdef0123456789abcdef/`;
const GOOGLE_PATH = `/${USER}/google-0123456789abcdef0123456789abcdef/`;

// Collection path → its supported-calendar-component-set, as Radicale reports it.
const COMPONENTS = {
  [`/${USER}/aufgaben/`]: ['VEVENT', 'VTODO'],
  [`/${USER}/privat/`]: ['VEVENT', 'VTODO'],
  [GOOGLE_PATH]: ['VEVENT'],
};

const STRANDED_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VTODO\r\nUID:task495\r\n'
  + 'DTSTAMP:20261001T000000Z\r\nSUMMARY:test1\r\nDESCRIPTION:kept on move\r\nSTATUS:NEEDS-ACTION\r\n'
  + 'END:VTODO\r\nEND:VCALENDAR\r\n';

// An in-memory Radicale: like the real one it stores a VTODO in any collection; only the
// component set it reports says what the collection is meant for.
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
      if (req.method === 'PROPFIND') {
        const comps = COMPONENTS[p];
        if (!comps) { res.writeHead(404); return res.end(); }
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>${p}</href><propstat><prop>
<resourcetype><C:calendar/><collection/></resourcetype>
<C:supported-calendar-component-set>${comps.map(c => `<C:comp name="${c}"/>`).join('')}</C:supported-calendar-component-set>
</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);
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
  app.use('/api/tasks', tasksRouter);
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn({ base: `http://127.0.0.1:${api.address().port}`, shard });
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => shard.server.close(resolve));
  }
}

function send(base, method, uid, body) {
  return fetch(`${base}/api/tasks${uid ? '/' + encodeURIComponent(uid) : ''}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function tasksIn(shard, collectionPath) {
  return [...shard.store.keys()].filter(k => k.startsWith(collectionPath));
}

test('creating a task in a collection without VTODO is refused and nothing is stored', async () => {
  await withSetup(async ({ base, shard }) => {
    const res = await send(base, 'POST', null, { calendarId: GOOGLE, title: 'test1' });
    assert.equal(res.status, 422, await res.clone().text());
    assert.match((await res.json()).error, /does not accept tasks/);
    assert.equal(shard.store.size, 0);
  });
});

test('creating a task in a task list still works', async () => {
  await withSetup(async ({ base, shard }) => {
    const res = await send(base, 'POST', null, { calendarId: LIST, title: 'test1' });
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal(tasksIn(shard, `/${USER}/aufgaben/`).length, 1);
  });
});

test('a stranded task cannot be rewritten in place in its non-VTODO collection', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`${GOOGLE_PATH}task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    const res = await send(base, 'PUT', 'task495', {
      calendarId: GOOGLE, href: `${GOOGLE_PATH}task495.ics`, etag: '"s1"', title: 'test1 renamed',
    });
    assert.equal(res.status, 422, await res.clone().text());
    assert.equal(shard.store.get(`${GOOGLE_PATH}task495.ics`).ics, STRANDED_ICS);
  });
});

test('a task stranded in the Google mirror moves to a shard list under the same UID', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`${GOOGLE_PATH}task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    const res = await send(base, 'PUT', 'task495', {
      calendarId: LIST, sourceCalendarId: GOOGLE, href: `${GOOGLE_PATH}task495.ics`, etag: '"s1"', title: 'test1',
    });
    assert.equal(res.status, 200, await res.clone().text());
    const saved = await res.json();
    assert.equal(saved.calendarId, LIST);
    assert.equal(new URL(saved.href, base).pathname, `/${USER}/aufgaben/task495.ics`);
    assert.equal(shard.store.has(`${GOOGLE_PATH}task495.ics`), false, 'the stranded copy is deleted');
    const moved = shard.store.get(`/${USER}/aufgaben/task495.ics`);
    assert.ok(moved, 'the task is created in the target list');
    assert.equal(saved.etag, moved.etag);
    assert.match(moved.ics, /UID:task495/);
    assert.match(moved.ics, /DESCRIPTION:kept on move/, 'fields the dialog did not send are kept');
  });
});

test('a task moves between two task lists', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`/${USER}/aufgaben/task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    const res = await send(base, 'PUT', 'task495', {
      calendarId: OTHER_LIST, sourceCalendarId: LIST, href: `/${USER}/aufgaben/task495.ics`, etag: '"s1"',
      title: 'test1 renamed',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(tasksIn(shard, `/${USER}/aufgaben/`), []);
    assert.match(shard.store.get(`/${USER}/privat/task495.ics`).ics, /SUMMARY:test1 renamed/);
  });
});

test('a task is not moved into a collection without VTODO', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`/${USER}/aufgaben/task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    const res = await send(base, 'PUT', 'task495', {
      calendarId: GOOGLE, sourceCalendarId: LIST, href: `/${USER}/aufgaben/task495.ics`, etag: '"s1"', title: 'test1',
    });
    assert.equal(res.status, 422, await res.clone().text());
    assert.equal(shard.store.get(`/${USER}/aufgaben/task495.ics`).ics, STRANDED_ICS);
    assert.deepEqual(tasksIn(shard, GOOGLE_PATH), []);
  });
});

test('a failed delete in the source removes the new copy again and reports the failure', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`${GOOGLE_PATH}task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    shard.fail.push(`DELETE ${GOOGLE_PATH}`);
    const res = await send(base, 'PUT', 'task495', {
      calendarId: LIST, sourceCalendarId: GOOGLE, href: `${GOOGLE_PATH}task495.ics`, etag: '"s1"', title: 'test1',
    });
    assert.ok(res.status >= 400, `the move must fail, got ${res.status}`);
    assert.equal(shard.store.get(`${GOOGLE_PATH}task495.ics`).ics, STRANDED_ICS, 'the source is untouched');
    assert.deepEqual(tasksIn(shard, `/${USER}/aufgaben/`), [], 'the copy in the target is removed again');
  });
});

test('a task the target already holds under its UID is not overwritten', async () => {
  await withSetup(async ({ base, shard }) => {
    shard.store.set(`${GOOGLE_PATH}task495.ics`, { ics: STRANDED_ICS, etag: '"s1"' });
    shard.store.set(`/${USER}/aufgaben/task495.ics`, { ics: 'OTHER', etag: '"o1"' });
    const res = await send(base, 'PUT', 'task495', {
      calendarId: LIST, sourceCalendarId: GOOGLE, href: `${GOOGLE_PATH}task495.ics`, etag: '"s1"', title: 'test1',
    });
    assert.equal(res.status, 409);
    assert.equal(shard.store.get(`/${USER}/aufgaben/task495.ics`).ics, 'OTHER');
    assert.equal(shard.store.get(`${GOOGLE_PATH}task495.ics`).ics, STRANDED_ICS);
  });
});
