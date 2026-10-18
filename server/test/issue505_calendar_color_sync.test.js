'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #505 — a colour set in the app must reach linked accounts. For a calendar the user may write,
// PATCH /api/calendars/:id stores the colour in the collection itself (`apple:calendar-color` via
// PROPPATCH), where the sync worker's vdirsyncer metasync picks it up; no per-user override may hide
// later changes coming from the provider. A refused PROPPATCH is an error, never a silent 200.
// For a read-only shared calendar the colour stays a local override (#4) and never reaches the collection.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue505-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue505.db');
process.env.ENCRYPTION_KEY = 'issue505-strong-encryption-key-for-tests-0123456789';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));

const OWN = 'internal-caldav::/u505/personal/';
const SHARED = 'internal-caldav::/u505-owner/family/';

function multistatus(href, propXml, status = 'HTTP/1.1 200 OK') {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">'
    + `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${propXml}</d:prop>`
    + `<d:status>${status}</d:status></d:propstat></d:response></d:multistatus>`;
}

// A Radicale stand-in that keeps each collection's calendar-color, so a GET after the PATCH shows
// what the collection (and therefore vdirsyncer) holds.
async function withStack(fn, { proppatchStatus = 'HTTP/1.1 200 OK' } = {}) {
  const proppatches = [];
  const colors = { '/u505/personal/': '#111111', '/u505-owner/family/': '#222222' };
  const dav = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      if (req.method === 'PROPPATCH') {
        proppatches.push({ url: req.url, body, acceptEncoding: req.headers['accept-encoding'] });
        const m = body.match(/<a:calendar-color>([^<]*)<\/a:calendar-color>/);
        if (m && proppatchStatus.includes(' 200 ')) colors[req.url] = m[1];
        res.end(multistatus(req.url, '<a:calendar-color/>', proppatchStatus));
        return;
      }
      const hrefs = req.url.startsWith('/u505-owner/') ? ['/u505-owner/family/'] : ['/u505/personal/'];
      res.end('<?xml version="1.0" encoding="utf-8"?>'
        + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">'
        + hrefs.map(h => `<d:response><d:href>${h}</d:href><d:propstat><d:prop>`
          + `<d:displayname>${h}</d:displayname><a:calendar-color>${colors[h] || ''}</a:calendar-color>`
          + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
          + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('')
        + '</d:multistatus>');
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davBase = `http://127.0.0.1:${dav.address().port}`;
  const prevInternal = process.env.INTERNAL_CALDAV_URL;
  process.env.INTERNAL_CALDAV_URL = davBase;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: req.headers['x-test-user'] || 'u505',
      accounts: [{ id: 'internal-caldav', authType: 'basic', url: `${davBase}/${req.headers['x-test-user'] || 'u505'}/`,
        username: req.headers['x-test-user'] || 'u505', password: 'x' }]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, proppatches, colors);
  } finally {
    if (prevInternal === undefined) delete process.env.INTERNAL_CALDAV_URL;
    else process.env.INTERNAL_CALDAV_URL = prevInternal;
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

const patch = (base, id, body, user) => fetch(`${base}/api/calendars/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Test-User': user } : {}) },
  body: JSON.stringify(body),
});

const listed = async (base, id, user) => {
  const res = await fetch(`${base}/api/calendars`, { headers: user ? { 'X-Test-User': user } : {} });
  assert.equal(res.status, 200);
  return (await res.json()).calendars.find(c => c.id === id);
};

test.before(async () => {
  await Db.ready;
  await dbRun(`INSERT INTO users (user_id, username) VALUES ('u505', 'testuser')`);
  await dbRun(`INSERT INTO users (user_id, username) VALUES ('u505-owner', 'testuser-owner')`);
  await Db.addUserShare(SHARED, 'u505', 0, 'ACCEPTED', 'READ');
});

test('Issue #505 — the colour of an own calendar is written to the collection, not into an override', async () => {
  await withStack(async (base, proppatches, colors) => {
    const res = await patch(base, OWN, { name: 'Persönlich', color: '#ab12cd' });
    assert.equal(res.status, 200);

    assert.equal(proppatches.length, 1);
    assert.equal(proppatches[0].url, '/u505/personal/');
    assert.equal(proppatches[0].acceptEncoding, 'identity');
    assert.match(proppatches[0].body, /<a:calendar-color>#ab12cd<\/a:calendar-color>/);
    assert.equal(colors['/u505/personal/'], '#ab12cd');
    assert.equal(await Db.getUserCalendarColorOverride('u505', OWN), null);

    // The provider changes the colour; the next sync writes it into the collection. The app shows it.
    colors['/u505/personal/'] = '#00ff00';
    assert.equal((await listed(base, OWN)).color, '#00ff00');
  });
});

test('Issue #505 — recolouring an own calendar drops an earlier override so synced colours show', async () => {
  await Db.setUserCalendarColorOverride('u505', OWN, '#999999');
  await withStack(async (base, proppatches, colors) => {
    const res = await patch(base, OWN, { color: '#123abc' });
    assert.equal(res.status, 200);
    assert.equal(await Db.getUserCalendarColorOverride('u505', OWN), null);
    colors['/u505/personal/'] = '#fedcba';
    assert.equal((await listed(base, OWN)).color, '#fedcba');
  });
});

test('Issue #505 — a refused PROPPATCH fails the request instead of answering 200', async () => {
  await withStack(async (base) => {
    const res = await patch(base, OWN, { color: '#ab12cd' });
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.equal(await Db.getUserCalendarColorOverride('u505', OWN), null);
  }, { proppatchStatus: 'HTTP/1.1 403 Forbidden' });
});

test('Issue #505 — a read-only shared calendar keeps a local override that never reaches the collection', async () => {
  await withStack(async (base, proppatches, colors) => {
    const res = await patch(base, SHARED, { color: '#ec4899' });
    assert.equal(res.status, 200);
    assert.equal(proppatches.length, 0);
    assert.equal(colors['/u505-owner/family/'], '#222222');
    assert.equal(await Db.getUserCalendarColorOverride('u505', SHARED), '#ec4899');
    assert.equal((await listed(base, SHARED)).color, '#ec4899');
  });
});
