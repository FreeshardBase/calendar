'use strict';
// Issue #193 — the sync worker pairs each Google calendar with a local collection named
// `google-<opaque id>` (see server/test/python/test_issue193_google_collection_mapping.py).
// This side: the app's own create route must never put a user calendar into the `google-`
// namespace, and db.js must hold the persisted Google-calendar ↔ local-collection mapping.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue193-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue193.db');
process.env.ENCRYPTION_KEY = 'issue193-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));
const dbAll = (sql, params = []) => new Promise((res, rej) => Db.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

async function withStack(fn) {
  const mkcalendars = [];
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'MKCALENDAR') mkcalendars.push(req.url);
      res.writeHead(req.method === 'MKCALENDAR' ? 201 : 207, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.address().port}/testuser/`;

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
  try {
    await fn(base, mkcalendars);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

async function create(base, name) {
  const queuedBefore = new Set((await dbAll('SELECT id FROM sync_queue')).map(r => r.id));
  const res = await fetch(`${base}/api/calendars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'acc', name })
  });
  // The route queues a sync job without awaiting it; wait until that job's transaction has
  // committed before the next create opens its own. A fixed sleep loses this race under load.
  if (res.status === 201) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const rows = await dbAll('SELECT id FROM sync_queue WHERE user_id = ?', ['testuser']);
      if (rows.some(r => !queuedBefore.has(r.id)) && !Db._inTx) break;
      assert.ok(Date.now() < deadline, 'the sync job queued by POST /api/calendars never committed');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return res;
}

test('Issue #193 — an app calendar named "Google …" is not created in the google- namespace', async () => {
  await withStack(async (base, mkcalendars) => {
    for (const name of ['Google Privat', 'google-0123456789abcdef0123456789abcdef', 'GOOGLE: Familie']) {
      const res = await create(base, name);
      assert.equal(res.status, 201, name);
      const body = await res.json();
      const collection = new URL(body.url).pathname.split('/').filter(Boolean).pop();
      assert.doesNotMatch(collection, /^google-/, `${name} -> ${collection}`);
      assert.equal(body.id, `acc::/testuser/${collection}/`);
    }
    assert.equal(mkcalendars.length, 3);
    for (const url of mkcalendars) assert.doesNotMatch(url, /\/testuser\/google-/);
  });
});

test('Issue #193 — ordinary names keep their readable path', async () => {
  await withStack(async (base, mkcalendars) => {
    const res = await create(base, 'Privat');
    assert.equal(res.status, 201);
    assert.deepEqual(mkcalendars, ['/testuser/privat/']);
  });
});

test('Issue #193 — google_calendar_collections keeps one local collection per Google calendar', async () => {
  await Db.ready;
  await dbRun(`INSERT INTO users (user_id, username) VALUES ('u193', 'testuser193')`);
  for (const id of ['g0', 'g1']) {
    await dbRun(
      `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type)
       VALUES (?, 'u193', ?, 'testuser@example.com', 'x', 'x', 'Google', 'oauth2')`, [id, `https://${id}.example.com/`]);
  }
  const insert = (acc, gid, col) => dbRun(
    `INSERT INTO google_calendar_collections (account_id, user_id, google_calendar_id, local_collection, created_at)
     VALUES (?, 'u193', ?, ?, 0)`, [acc, gid, col]);

  await insert('g0', 'primary', 'google-aaaa');
  await insert('g1', 'primary', 'google-bbbb');
  // Two Google calendars of one user can never share a local collection, even across accounts.
  await assert.rejects(insert('g1', 'other', 'google-aaaa'), /UNIQUE/);
  // One Google calendar of one account has exactly one local collection.
  await assert.rejects(insert('g0', 'primary', 'google-cccc'), /UNIQUE|PRIMARY/);

  // Unlinking the account drops its mappings.
  await dbRun(`DELETE FROM linked_accounts WHERE id = 'g0'`);
  const rows = await dbAll(`SELECT account_id FROM google_calendar_collections WHERE user_id = 'u193'`);
  assert.deepEqual(rows.map(r => r.account_id), ['g1']);
});
