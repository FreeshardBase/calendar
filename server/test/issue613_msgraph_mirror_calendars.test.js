'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #613 — each Microsoft calendar is mirrored into its own collection (`msgraph-<hex>`, paired in
// msgraph_calendar_collections by the sync worker). GET /api/calendars names the Microsoft account a
// mirror belongs to, so the sidebar lists it under that account; a mirror counts as linked for the
// trash; deleting a mirror or disconnecting the account unpairs it without touching Radicale.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue613-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue613.db');
process.env.ENCRYPTION_KEY = 'issue613-strong-encryption-key-for-tests-0123456789';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));
const dbAll = (sql, params = []) => new Promise((res, rej) => Db.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

function calendarResponse(href, name) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${name}</d:displayname>`
    + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

async function withStack(fn) {
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        + calendarResponse('/u613/personal/', 'Persönlich')
        + calendarResponse('/u613/msgraph-0123456789abcdef/', 'Arbeit')
        + calendarResponse('/u613/msgraph-fedcba9876543210/', 'Familie')
        + '</d:multistatus>');
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'u613',
      accounts: [{ id: 'internal-caldav', authType: 'basic', url: `http://127.0.0.1:${dav.address().port}/u613/`, username: 'u613', password: 'x' }]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

async function pairMirrors() {
  const account = await Db.addMSGraphAccount({ userId: 'u613', accountEmail: 'testuser@example.com', accessToken: 'a', refreshToken: 'r' });
  for (const [graphId, collection] of [['cal-work', 'msgraph-0123456789abcdef'], ['cal-family', 'msgraph-fedcba9876543210']]) {
    await dbRun(
      `INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection, created_at)
       VALUES (?, 'u613', ?, ?, 0)`, [account.id, graphId, collection]);
  }
  await dbRun(
    `INSERT INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at, href, local_etag)
     VALUES ('e1', 'g1', ?, 0, '/u613/msgraph-0123456789abcdef/e1.ics', '"1"'),
            ('e2', 'g2', ?, 0, '/u613/msgraph-fedcba9876543210/e2.ics', '"2"')`, [account.id, account.id]);
  return account.id;
}

test.beforeEach(async () => {
  await Db.ready;
  await dbRun('DELETE FROM msgraph_calendar_collections');
  await dbRun('DELETE FROM msgraph_event_mappings');
  await dbRun('DELETE FROM msgraph_accounts');
  await dbRun('DELETE FROM detached_mirrors');
});

test('Issue #613 — GET /api/calendars lists each Microsoft mirror under its account, by the account e-mail', async () => {
  const accountId = await pairMirrors();
  await withStack(async (base) => {
    const res = await fetch(`${base}/api/calendars`);
    assert.equal(res.status, 200);
    const { calendars } = await res.json();
    const byName = Object.fromEntries(calendars.map(c => [c.name, [c.linkedAccountId, c.linkedAccountName ?? null]]));
    assert.deepEqual(byName, {
      'Persönlich': [null, null],
      'Arbeit': [accountId, 'testuser@example.com'],
      'Familie': [accountId, 'testuser@example.com'],
    });
  });
  // A restore into a mirror re-creates the item at Microsoft, which the restore dialog says.
  const mirrored = await Db.getMirroredCollectionAccounts('u613');
  assert.equal(mirrored.get('msgraph-0123456789abcdef').accountId, accountId);
  assert.equal(mirrored.has('personal'), false);
});

test('Issue #613 — deleting a mirror unpairs only that calendar, nothing at Microsoft is mapped to it any more', async () => {
  await pairMirrors();
  await Db.deleteCalendarData('internal-caldav::/u613/msgraph-0123456789abcdef/');
  assert.deepEqual((await dbAll('SELECT local_collection FROM msgraph_calendar_collections')).map(r => r.local_collection),
    ['msgraph-fedcba9876543210']);
  assert.deepEqual((await dbAll('SELECT graph_id FROM msgraph_event_mappings')).map(r => r.graph_id), ['g2']);
});

test('Issue #613 — disconnecting the account unpairs all its mirrors', async () => {
  const accountId = await pairMirrors();
  await Db.deleteMSGraphAccount(accountId);
  assert.deepEqual(await dbAll('SELECT * FROM msgraph_calendar_collections'), []);
  // #614: the event mappings stay with the kept calendars, for a later re-attach.
  assert.deepEqual((await dbAll('SELECT graph_id FROM msgraph_event_mappings ORDER BY graph_id')).map(r => r.graph_id), ['g1', 'g2']);
});
