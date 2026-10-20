'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// A new user's first page load asks GET /api/calendars from the SPA while other requests of the same
// user (the e2e spec's own, a second tab) ask it too. Every request saw "no collections yet" and ran
// MKCALENDAR; Radicale refuses the second one for an existing collection, and that request answered
// with an empty list, so the user saw no calendar at all (CI: #348's spec found no writable
// calendar). The default collections are created once per principal and every request lists them.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue512-race-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue512-race.db');
process.env.ENCRYPTION_KEY = 'issue512-race-strong-encryption-key-for-tests-0123';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');

// A Radicale stand-in with state: PROPFIND lists what exists, MKCALENDAR on an existing collection
// is refused with 409 as Radicale does. MKCALENDAR is slow, so concurrent first loads overlap.
async function withRadicale(fn) {
  const collections = new Map();
  const mkcalendars = [];
  const dav = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'MKCALENDAR') {
        mkcalendars.push(req.url);
        setTimeout(() => {
          if (collections.has(req.url)) {
            res.writeHead(409);
            return res.end();
          }
          const name = body.match(/<d:displayname>([^<]*)<\/d:displayname>/)[1];
          const comps = [...body.matchAll(/<c:comp name="([A-Z]+)"\s*\/>/g)].map(m => m[1]);
          collections.set(req.url, { name, comps });
          res.writeHead(201);
          res.end();
        }, 50);
        return;
      }
      const responses = [...collections].map(([href, { name, comps }]) =>
        `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
        + `<d:displayname>${name}</d:displayname>`
        + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
        + `<c:supported-calendar-component-set>${comps.map(c => `<c:comp name="${c}"/>`).join('')}</c:supported-calendar-component-set>`
        + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>').join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="utf-8"?>'
        + `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`);
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const davUrl = `http://127.0.0.1:${dav.address().port}/testuser/`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'testuser',
      accounts: [{ id: 'internal-caldav', authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, mkcalendars);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

test('concurrent first loads of a new user all list the default Kalender and Aufgabenliste', async () => {
  await withRadicale(async (base, mkcalendars) => {
    const lists = await Promise.all([1, 2, 3].map(async () => {
      const res = await fetch(`${base}/api/calendars`);
      assert.equal(res.status, 200);
      return (await res.json()).calendars;
    }));
    for (const calendars of lists) {
      assert.deepEqual(calendars.map(c => [c.href, c.supportsVEVENT, c.supportsVTODO]).sort(), [
        ['/testuser/personal/', true, false],
        ['/testuser/tasks/', false, true],
      ]);
    }
    assert.deepEqual(mkcalendars, ['/testuser/personal/', '/testuser/tasks/']);
  });
});
