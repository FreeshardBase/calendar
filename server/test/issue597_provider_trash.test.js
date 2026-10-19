'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #597 — an item a sync found deleted at the provider lands in the shard trash.
 *
 * The sync workers write such a row themselves (sync-worker/provider_trash.py: origin 'provider',
 * linked). The app lists it as deleted at the provider, purges it after 30 days like the others,
 * and restoring one from the Microsoft 365 import puts it back into Radicale and queues it in
 * `msgraph_restores`, from which the Graph worker creates it at Microsoft again.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue597-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue597.db');
process.env.ENCRYPTION_KEY = 'issue597-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');

const Db = require('../db');
const trashRouter = require('../routes/trash');

const USER = 'testuser';
const CAL = `internal-caldav::/${USER}/persoenlich/`;
const HREF = `/${USER}/persoenlich/msgraph-event-g-old.ics`;
const EVENT_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:msgraph-event-g-old\r\n'
  + 'SUMMARY:Planning with Test User\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\n'
  + 'END:VEVENT\r\nEND:VCALENDAR\r\n';
const DAY = 24 * 60 * 60 * 1000;

function sql(method, statement, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(process.env.DATABASE_PATH);
    db.configure('busyTimeout', 5000);
    db[method](statement, params, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
  });
}

// The row sync-worker/provider_trash.py writes.
async function providerTrashRow(id, { title = 'Planning with Test User', deletedAt = Date.now(), msgraph } = {}) {
  const payload = { href: HREF, ics: EVENT_ICS, ...(msgraph ? { msgraph } : {}) };
  await sql('run', `INSERT INTO trash_items (id, user_id, kind, calendar_id, title, linked, origin, payload, deleted_at)
    VALUES (?, ?, 'event', ?, ?, 1, 'provider', ?, ?)`, [id, USER, CAL, title, JSON.stringify(payload), deletedAt]);
}

// The local Radicale: one collection, items by path.
async function withSetup(fn) {
  const store = new Map();
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (req.method === 'PROPFIND' && p === `/${USER}/persoenlich/`) {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      }
      if (req.method === 'PUT') {
        if (store.has(p) && req.headers['if-none-match'] === '*') { res.writeHead(412); return res.end(); }
        store.set(p, true);
        res.writeHead(201, { ETag: '"e1"' });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.address().port}/${USER}/`;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: USER,
      accounts: [{ id: 'internal-caldav', authType: 'basic', url: davUrl, username: USER, password: 'testuser-password' }],
    };
    next();
  });
  app.use('/api/trash', trashRouter);
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = (method, url) => fetch(`http://127.0.0.1:${api.address().port}${url}`, { method });
  try {
    await fn({ call, store });
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => dav.close(resolve));
  }
}

async function json(res) {
  const text = await res.text();
  assert.ok(res.ok, `HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

test.before(() => Db.ready);
test.beforeEach(() => Promise.all([sql('run', 'DELETE FROM trash_items'), sql('run', 'DELETE FROM msgraph_restores')]));

test('an item deleted at the provider is listed as such, linked, and purged after 30 days', async () => {
  await withSetup(async ({ call }) => {
    await providerTrashRow('p-fresh', { deletedAt: Date.now() - 29 * DAY });
    await providerTrashRow('p-old', { title: 'Old', deletedAt: Date.now() - 31 * DAY });
    await Db.addTrashItem({ userId: USER, kind: 'event', calendarId: CAL, title: 'Deleted in the app',
      payload: { href: `/${USER}/persoenlich/app.ics`, ics: EVENT_ICS } });

    const { items } = await json(await call('GET', '/api/trash'));
    const fresh = items.find(i => i.id === 'p-fresh');
    assert.ok(fresh, 'a 29-day-old provider delete is listed');
    assert.equal(fresh.deletedAtProvider, true);
    assert.equal(fresh.linked, true);
    assert.equal(fresh.kind, 'event');
    assert.equal(fresh.title, 'Planning with Test User');
    assert.equal(items.find(i => i.title === 'Deleted in the app').deletedAtProvider, false);
    assert.equal(items.some(i => i.id === 'p-old'), false, 'a 31-day-old one is purged');
    assert.equal(await Db.getTrashItem('p-old', USER), null);
  });
});

test('restoring a Microsoft 365 item puts it back and queues its re-creation at Graph', async () => {
  await Db.addMSGraphAccount({ id: 'acc-graph', userId: USER, accountEmail: 'testuser@example.com',
    accessToken: 'testuser-access', refreshToken: 'testuser-refresh', expiresAt: 0, targetCalendarId: 'persoenlich' });
  await withSetup(async ({ call, store }) => {
    await providerTrashRow('p-graph', { msgraph: { accountId: 'acc-graph' } });

    await json(await call('POST', '/api/trash/p-graph/restore'));

    assert.equal(store.has(HREF), true, 'the item is back in Radicale');
    assert.deepEqual(await sql('all', 'SELECT account_id, href FROM msgraph_restores'),
      [{ account_id: 'acc-graph', href: HREF }]);
    assert.equal(await Db.getTrashItem('p-graph', USER), null);
  });
});

test('a Microsoft 365 item whose account was disconnected is restored as a local one', async () => {
  await withSetup(async ({ call, store }) => {
    await providerTrashRow('p-orphan', { msgraph: { accountId: 'acc-gone' } });

    await json(await call('POST', '/api/trash/p-orphan/restore'));

    assert.equal(store.has(HREF), true);
    assert.deepEqual(await sql('all', 'SELECT account_id FROM msgraph_restores'), []);
  });
});
