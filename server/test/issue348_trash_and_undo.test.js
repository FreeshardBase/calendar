'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #348 — one trash for calendars, task lists, events and tasks.
 *
 * Every delete keeps a copy in the shard's trash (`trash_items`): DELETE answers with its
 * `trashId`, GET /api/trash lists it, POST /api/trash/:id/restore puts it back into Radicale
 * under the same UID (the "Undo" toast uses the same call), DELETE /api/trash/:id purges it.
 * Items older than 30 days are purged and no longer listed.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue348-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue348.db');
process.env.ENCRYPTION_KEY = 'issue348-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const eventsRouter = require('../routes/events');
const tasksRouter = require('../routes/tasks');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const trashRouter = require('../routes/trash');

const USER = 'testuser';
const CAL = `internal-caldav::/${USER}/work/`;

const EVENT_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:evt348\r\n'
  + 'DTSTAMP:20261001T000000Z\r\nSUMMARY:Planning\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n'
  + 'END:VEVENT\r\nEND:VCALENDAR\r\n';
const TASK_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VTODO\r\nUID:task348\r\n'
  + 'DTSTAMP:20261001T000000Z\r\nSUMMARY:Write report\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// An in-memory CalDAV server: collections (path → props) and items (path → { ics, etag }).
function davServer() {
  const collections = new Map();
  const store = new Map();
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const item = store.get(p);
      const ifMatch = req.headers['if-match'];
      if (ifMatch && (!item || item.etag !== ifMatch)) { res.writeHead(412); return res.end(); }
      const parent = p.replace(/[^/]+$/, '');
      if (req.method === 'GET') {
        if (!item) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: item.etag });
        return res.end(item.ics);
      }
      if (req.method === 'PUT') {
        if (!collections.has(parent)) { res.writeHead(409); return res.end(); }
        if (req.headers['if-none-match'] === '*' && item) { res.writeHead(412); return res.end(); }
        counter += 1;
        const etag = `"e${counter}"`;
        store.set(p, { ics: body, etag });
        res.writeHead(item ? 204 : 201, { ETag: etag });
        return res.end();
      }
      if (req.method === 'DELETE') {
        if (collections.has(p)) {
          collections.delete(p);
          for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k);
          res.writeHead(204);
          return res.end();
        }
        if (!item) { res.writeHead(404); return res.end(); }
        store.delete(p);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'MKCALENDAR') {
        if (collections.has(p)) { res.writeHead(405); return res.end(); }
        const name = /<d:displayname>([^<]*)<\/d:displayname>/.exec(body);
        const comps = [...body.matchAll(/<c:comp name="(\w+)"\/>/g)].map(m => m[1]);
        collections.set(p, { name: name ? name[1] : '', color: null, comps });
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'PROPPATCH') {
        const color = /<a:calendar-color>([^<]*)<\/a:calendar-color>/.exec(body);
        if (collections.has(p) && color) collections.get(p).color = color[1];
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      }
      if (req.method === 'PROPFIND') {
        const col = collections.get(p);
        if (!col) { res.writeHead(404); return res.end(); }
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
<d:response><d:href>${p}</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${xmlEsc(col.name)}</d:displayname>
${col.color ? `<a:calendar-color>${col.color}</a:calendar-color>` : ''}
<c:supported-calendar-component-set>${col.comps.map(c => `<c:comp name="${c}"/>`).join('')}</c:supported-calendar-component-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      }
      if (req.method === 'REPORT') {
        if (!collections.has(p)) { res.writeHead(404); return res.end(); }
        const rows = [...store.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) =>
          `<d:response><d:href>${k}</d:href><d:propstat><d:prop><d:getetag>${v.etag}</d:getetag>`
          + `<c:calendar-data>${xmlEsc(v.ics)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows.join('')}</d:multistatus>`);
      }
      res.writeHead(405);
      res.end();
    });
  });
  return { server, store, collections };
}

async function withSetup(fn, userId = USER) {
  const dav = davServer();
  await new Promise((resolve) => dav.server.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.server.address().port}/${USER}/`;
  dav.collections.set(`/${USER}/work/`, { name: 'Work', color: '#336699', comps: ['VEVENT', 'VTODO'] });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const current = req.get('x-test-user') || userId;
    req.session = {
      userId: current,
      accounts: [
        { id: 'internal-caldav', authType: 'basic', url: davUrl, username: current, password: 'testuser-password' },
        // A linked provider account (external CalDAV); the in-memory server stands in for the provider.
        { id: 'acct-provider', type: 'caldav', authType: 'basic', url: davUrl, username: current, password: 'testuser-password' },
      ],
    };
    next();
  });
  app.use('/api/events', eventsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/calendars', calendarsRouter);
  app.use('/api/trash', trashRouter);
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = (method, url, body, headers = {}) => fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    await fn({ call, dav });
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => dav.server.close(resolve));
  }
}

async function json(res) {
  const text = await res.text();
  assert.ok(res.ok, `HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

test('a deleted event goes to the trash and is restored under the same UID', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348',
      { calendarId: CAL, href: `/${USER}/work/evt348.ics`, etag: '"s1"' }));
    assert.equal(dav.store.has(`/${USER}/work/evt348.ics`), false, 'the event is deleted from Radicale');
    assert.ok(del.trashId, 'the delete answers with the trash entry');

    const list = await json(await call('GET', '/api/trash'));
    const entry = list.items.find(i => i.id === del.trashId);
    assert.ok(entry, 'the trash lists the event');
    assert.equal(entry.kind, 'event');
    assert.equal(entry.title, 'Planning');
    assert.equal(entry.calendarId, CAL);

    await json(await call('POST', `/api/trash/${del.trashId}/restore`));
    const restored = dav.store.get(`/${USER}/work/evt348.ics`);
    assert.ok(restored, 'the event is back at its href');
    assert.match(restored.ics, /UID:evt348/);
    assert.match(restored.ics, /SUMMARY:Planning/);
    const after = await json(await call('GET', '/api/trash'));
    assert.equal(after.items.some(i => i.id === del.trashId), false, 'a restored item leaves the trash');
  });
});

test('deleting a single occurrence is not a trash entry: the series stays', async () => {
  await withSetup(async ({ call, dav }) => {
    const series = EVENT_ICS.replace('DTEND:20261020T100000Z\r\n', 'DTEND:20261020T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n');
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: series, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348',
      { calendarId: CAL, href: `/${USER}/work/evt348.ics`, etag: '"s1"', scope: 'occurrence', recurrenceId: '20261021T090000Z' }));
    assert.equal(del.trashId, undefined);
    assert.equal((await json(await call('GET', '/api/trash'))).items.some(i => i.title === 'Planning' && i.kind === 'event'), false);
  });
});

test('a deleted task goes to the trash and is restored', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/task348.ics`, { ics: TASK_ICS, etag: '"t1"' });
    const del = await json(await call('DELETE', '/api/tasks/task348',
      { calendarId: CAL, href: `/${USER}/work/task348.ics`, etag: '"t1"' }));
    assert.equal(dav.store.has(`/${USER}/work/task348.ics`), false);
    const entry = (await json(await call('GET', '/api/trash'))).items.find(i => i.id === del.trashId);
    assert.equal(entry.kind, 'task');
    assert.equal(entry.title, 'Write report');

    await json(await call('POST', `/api/trash/${del.trashId}/restore`));
    assert.match(dav.store.get(`/${USER}/work/task348.ics`).ics, /UID:task348/);
  });
});

test('a restore never overwrites an item that was created again under the same href', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348', { calendarId: CAL, href: `/${USER}/work/evt348.ics` }));
    const newer = EVENT_ICS.replace('SUMMARY:Planning', 'SUMMARY:Newer');
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: newer, etag: '"s2"' });
    const res = await call('POST', `/api/trash/${del.trashId}/restore`);
    assert.equal(res.status, 409);
    assert.match(dav.store.get(`/${USER}/work/evt348.ics`).ics, /SUMMARY:Newer/);
    assert.ok((await json(await call('GET', '/api/trash'))).items.some(i => i.id === del.trashId), 'the entry stays in the trash');
  });
});

test('a delete in a linked calendar deletes at the provider, keeps a copy marked linked and restores there', async () => {
  await withSetup(async ({ call, dav }) => {
    const providerCal = `acct-provider::/${USER}/work/`;
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348',
      { calendarId: providerCal, href: `/${USER}/work/evt348.ics`, etag: '"s1"' }));
    assert.equal(dav.store.has(`/${USER}/work/evt348.ics`), false, 'the event is deleted at the provider');
    const entry = (await json(await call('GET', '/api/trash'))).items.find(i => i.id === del.trashId);
    assert.equal(entry.linked, true, 'the restore dialog warns about a new UID / invitation');
    assert.equal(entry.calendarId, providerCal);

    await json(await call('POST', `/api/trash/${del.trashId}/restore`));
    assert.match(dav.store.get(`/${USER}/work/evt348.ics`).ics, /SUMMARY:Planning/, 'restored at the provider');
  });
});

test('an internal calendar entry is not marked linked', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348', { calendarId: CAL, href: `/${USER}/work/evt348.ics` }));
    const entry = (await json(await call('GET', '/api/trash'))).items.find(i => i.id === del.trashId);
    assert.equal(entry.linked, false);
  });
});

test('a deleted task list goes to the trash as a task-only collection and comes back as one', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.collections.set(`/${USER}/todo/`, { name: 'Todo', color: null, comps: ['VTODO'] });
    dav.store.set(`/${USER}/todo/task348.ics`, { ics: TASK_ICS, etag: '"t1"' });
    const listId = `internal-caldav::/${USER}/todo/`;
    const del = await json(await call('DELETE', `/api/calendars/${encodeURIComponent(listId)}`));
    assert.equal(dav.collections.has(`/${USER}/todo/`), false);
    const entry = (await json(await call('GET', '/api/trash'))).items.find(i => i.id === del.trashId);
    assert.equal(entry.kind, 'calendar');
    assert.deepEqual(entry.components, ['VTODO'], 'the trash can tell a task list from a calendar');
    assert.equal(entry.itemCount, 1);

    await json(await call('POST', `/api/trash/${del.trashId}/restore`));
    assert.deepEqual(dav.collections.get(`/${USER}/todo/`).comps, ['VTODO']);
    assert.match(dav.store.get(`/${USER}/todo/task348.ics`).ics, /UID:task348/);
  });
});

test('a deleted calendar goes to the trash with its items and is restored as it was', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    dav.store.set(`/${USER}/work/task348.ics`, { ics: TASK_ICS, etag: '"t1"' });
    const del = await json(await call('DELETE', `/api/calendars/${encodeURIComponent(CAL)}`));
    assert.equal(dav.collections.has(`/${USER}/work/`), false, 'the collection is deleted');
    assert.equal(dav.store.size, 0);

    const entry = (await json(await call('GET', '/api/trash'))).items.find(i => i.id === del.trashId);
    assert.equal(entry.kind, 'calendar');
    assert.equal(entry.title, 'Work');
    assert.equal(entry.itemCount, 2);

    await json(await call('POST', `/api/trash/${del.trashId}/restore`));
    const col = dav.collections.get(`/${USER}/work/`);
    assert.ok(col, 'the collection is created again at its path');
    assert.equal(col.name, 'Work');
    assert.equal(col.color, '#336699');
    assert.deepEqual(col.comps, ['VEVENT', 'VTODO']);
    assert.match(dav.store.get(`/${USER}/work/evt348.ics`).ics, /SUMMARY:Planning/);
    assert.match(dav.store.get(`/${USER}/work/task348.ics`).ics, /SUMMARY:Write report/);
  });
});

test('restoring an event whose calendar is gone says so and keeps the entry', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348', { calendarId: CAL, href: `/${USER}/work/evt348.ics` }));
    dav.collections.delete(`/${USER}/work/`);
    const res = await call('POST', `/api/trash/${del.trashId}/restore`);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Kalender/);
  });
});

test('the trash is per person: another user neither sees nor restores nor purges an entry', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348', { calendarId: CAL, href: `/${USER}/work/evt348.ics` }));
    const other = { 'x-test-user': 'otheruser' };
    const list = await json(await call('GET', '/api/trash', null, other));
    assert.equal(list.items.some(i => i.id === del.trashId), false);
    assert.equal((await call('POST', `/api/trash/${del.trashId}/restore`, null, other)).status, 404);
    assert.equal((await call('DELETE', `/api/trash/${del.trashId}`, null, other)).status, 404);
    assert.equal(dav.store.has(`/${USER}/work/evt348.ics`), false);
  });
});

test('purging an entry removes it for good', async () => {
  await withSetup(async ({ call, dav }) => {
    dav.store.set(`/${USER}/work/evt348.ics`, { ics: EVENT_ICS, etag: '"s1"' });
    const del = await json(await call('DELETE', '/api/events/evt348', { calendarId: CAL, href: `/${USER}/work/evt348.ics` }));
    await json(await call('DELETE', `/api/trash/${del.trashId}`));
    assert.equal((await json(await call('GET', '/api/trash'))).items.some(i => i.id === del.trashId), false);
    assert.equal((await call('POST', `/api/trash/${del.trashId}/restore`)).status, 404);
  });
});

test('entries are kept for 30 days and then purged', async () => {
  await withSetup(async ({ call }) => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const fresh = await Db.addTrashItem({ userId: USER, kind: 'event', calendarId: CAL, title: 'Fresh',
      payload: { href: `/${USER}/work/a.ics`, ics: EVENT_ICS }, deletedAt: now - 29 * day });
    const old = await Db.addTrashItem({ userId: USER, kind: 'event', calendarId: CAL, title: 'Old',
      payload: { href: `/${USER}/work/b.ics`, ics: EVENT_ICS }, deletedAt: now - 31 * day });
    const list = await json(await call('GET', '/api/trash'));
    const fe = list.items.find(i => i.id === fresh);
    assert.ok(fe, 'a 29-day-old entry is listed');
    assert.equal(new Date(fe.purgeAt).getTime(), now - 29 * day + 30 * day);
    assert.equal(list.items.some(i => i.id === old), false, 'a 31-day-old entry is not');
    assert.equal(await Db.purgeExpiredTrash(now), 0, 'the listing already purged it');
    assert.equal(await Db.getTrashItem(old, USER), null);
  });
});
