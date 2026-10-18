'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #504 — the user reorders calendars, task lists and subscriptions in the sidebar.
// PUT /api/calendars/order stores the order of one sidebar group per user; GET /api/calendars and
// GET /api/webcal/subscriptions return their entries in that order. The user's own CalDAV collections
// also get `apple:calendar-order`, so native clients follow; shared and subscribed ones do not.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue504-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue504.db');
process.env.ENCRYPTION_KEY = 'issue504-strong-encryption-key-for-tests-0123456789';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const webcalRouter = require('../routes/webcal');
const Db = require('../db');

const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));

function calendarResponse(href, name) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${name}</d:displayname>`
    + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

const LISTING = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + calendarResponse('/u504/personal/', 'Persönlich')
  + calendarResponse('/u504/work/', 'Arbeit')
  + calendarResponse('/u504/family/', 'Familie')
  + '</d:multistatus>';

async function withStack(fn) {
  const proppatches = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'PROPPATCH') {
        proppatches.push({ url: req.url, body, acceptEncoding: req.headers['accept-encoding'] });
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(LISTING);
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davBase = `http://127.0.0.1:${dav.address().port}`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'u504',
      accounts: [{ id: 'internal-caldav', authType: 'basic', url: `${davBase}/u504/`, username: 'u504', password: 'x' }]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  app.use('/api/webcal', webcalRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, proppatches);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

const putOrder = (base, calendarIds) => fetch(`${base}/api/calendars/order`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ calendarIds }),
});

const ID = slug => `internal-caldav::/u504/${slug}/`;

test.before(async () => {
  await Db.ready;
  await dbRun(`INSERT INTO users (user_id, username) VALUES ('u504', 'testuser')`);
});

test('Issue #504 — the stored order sorts GET /api/calendars and survives later requests', async () => {
  await withStack(async (base) => {
    const before = await (await fetch(`${base}/api/calendars`)).json();
    assert.deepEqual(before.calendars.map(c => c.name), ['Persönlich', 'Arbeit', 'Familie']);

    const res = await putOrder(base, [ID('family'), ID('personal'), ID('work')]);
    assert.equal(res.status, 200);

    for (let i = 0; i < 2; i++) {
      const after = await (await fetch(`${base}/api/calendars`)).json();
      assert.deepEqual(after.calendars.map(c => c.name), ['Familie', 'Persönlich', 'Arbeit']);
    }
  });
});

test('Issue #504 — the user\'s own collections get apple:calendar-order via PROPPATCH', async () => {
  await withStack(async (base, proppatches) => {
    const res = await putOrder(base, [ID('work'), ID('family'), ID('personal')]);
    assert.equal(res.status, 200);

    const orderByUrl = Object.fromEntries(proppatches.map(p => {
      assert.match(p.body, /xmlns:a="http:\/\/apple\.com\/ns\/ical\/"/);
      assert.equal(p.acceptEncoding, 'identity');
      return [p.url, Number(p.body.match(/<a:calendar-order>(\d+)<\/a:calendar-order>/)[1])];
    }));
    assert.deepEqual(orderByUrl, { '/u504/work/': 1, '/u504/family/': 2, '/u504/personal/': 3 });
  });
});

test('Issue #504 — a calendar shared by someone else is ordered for the user but never PROPPATCHed', async () => {
  await withStack(async (base, proppatches) => {
    const res = await putOrder(base, ['internal-caldav::/other-user/cal/', ID('personal')]);
    assert.equal(res.status, 200);
    assert.deepEqual(proppatches.map(p => p.url), ['/u504/personal/']);
  });
});

test('Issue #504 — subscriptions are ordered by the same store', async () => {
  const a = await Db.createWebcalSubscription({ userId: 'u504', name: 'Feiertage', url: 'https://example.com/a.ics' });
  const b = await Db.createWebcalSubscription({ userId: 'u504', name: 'Schulferien', url: 'https://example.com/b.ics' });
  const c = await Db.createWebcalSubscription({ userId: 'u504', name: 'Müllabfuhr', url: 'https://example.com/c.ics' });
  await withStack(async (base, proppatches) => {
    const res = await putOrder(base, [`webcal::${b.id}`, `webcal::${c.id}`, `webcal::${a.id}`]);
    assert.equal(res.status, 200);
    assert.equal(proppatches.length, 0);
    const { subscriptions } = await (await fetch(`${base}/api/webcal/subscriptions`)).json();
    assert.deepEqual(subscriptions.map(s => s.name), ['Schulferien', 'Müllabfuhr', 'Feiertage']);
  });
});

test('Issue #504 — PUT /api/calendars/order rejects a malformed body', async () => {
  await withStack(async (base) => {
    for (const calendarIds of [undefined, 'x', [], [1], [''], [ID('work'), ID('work')]]) {
      const res = await putOrder(base, calendarIds);
      assert.equal(res.status, 400, JSON.stringify(calendarIds));
    }
  });
});
