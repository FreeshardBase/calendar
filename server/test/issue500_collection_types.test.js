'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #500 — a new collection is either a Kalender (VEVENT), an Aufgabenliste (VTODO) or,
// explicitly, both. MKCALENDAR must say so in supported-calendar-component-set, or native
// clients show every collection both as a calendar and as a task list.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue500-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue500.db');
process.env.ENCRYPTION_KEY = 'issue500-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const dbAll = (sql, params = []) => new Promise((res, rej) => Db.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

// The component names a MKCALENDAR body asks for, in order.
function components(body) {
  const set = body.match(/<c:supported-calendar-component-set>([\s\S]*?)<\/c:supported-calendar-component-set>/);
  assert.ok(set, `MKCALENDAR without supported-calendar-component-set:\n${body}`);
  return [...set[1].matchAll(/<c:comp name="([A-Z]+)"\s*\/>/g)].map(m => m[1]);
}

async function withStack(accountId, fn) {
  const mkcalendars = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'MKCALENDAR') mkcalendars.push({ url: req.url, components: components(body) });
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
      accounts: [{ id: accountId, authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
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

async function create(base, data) {
  const queuedBefore = new Set((await dbAll('SELECT id FROM sync_queue')).map(r => r.id));
  const res = await fetch(`${base}/api/calendars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'acc', ...data })
  });
  // The route queues a sync job without awaiting it; wait for its commit (see issue193 test).
  if (res.status === 201) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const rows = await dbAll('SELECT id FROM sync_queue WHERE user_id = ?', ['testuser']);
      if (rows.some(r => !queuedBefore.has(r.id))) break;
      assert.ok(Date.now() < deadline, 'the sync job queued by POST /api/calendars never committed');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return res;
}

test('Issue #500 — the collection type decides the MKCALENDAR component set', async () => {
  await withStack('acc', async (base, mkcalendars) => {
    for (const [type, name, expected] of [
      ['calendar', 'Termine 500', ['VEVENT']],
      ['tasklist', 'Einkauf 500', ['VTODO']],
      ['mixed', 'Gemischt 500', ['VEVENT', 'VTODO']],
    ]) {
      mkcalendars.length = 0;
      const res = await create(base, { name, type });
      assert.equal(res.status, 201, type);
      assert.equal(mkcalendars.length, 1, type);
      assert.deepEqual(mkcalendars[0].components, expected, type);
    }
  });
});

test('Issue #500 — a create without a known type is refused before any MKCALENDAR', async () => {
  await withStack('acc', async (base, mkcalendars) => {
    for (const data of [{ name: 'Ohne Typ' }, { name: 'Falscher Typ', type: 'VJOURNAL' }]) {
      const res = await create(base, data);
      assert.equal(res.status, 400, JSON.stringify(data));
      assert.match((await res.json()).error, /type/);
    }
    assert.deepEqual(mkcalendars, []);
  });
});

test('Issue #500 — a new shard user gets a Kalender and a separate Aufgabenliste', async () => {
  await withStack('internal-caldav', async (base, mkcalendars) => {
    const res = await fetch(`${base}/api/calendars`);
    assert.equal(res.status, 200);
    assert.deepEqual(mkcalendars, [
      { url: '/testuser/personal/', components: ['VEVENT'] },
      { url: '/testuser/tasks/', components: ['VTODO'] },
    ]);
  });
});
