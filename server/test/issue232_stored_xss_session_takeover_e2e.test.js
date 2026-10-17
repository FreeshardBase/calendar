'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #232 — the #202 chain: an authenticated attacker writes into (or grants
// itself a share on) a victim's internal CalDAV collection. The app-layer gate
// must authorize the same collection the request is actually sent to: a
// calendar href whose dot-segments only resolve after percent-decoding
// ("%2e%2e", "..%2f") must not authorize as the attacker's own calendar while
// the CalDAV request lands in the victim's. Runs with production semantics
// against a loopback stand-in for Radicale that records every request.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { taskListMultistatus } = require('./helpers/taskListPropfind');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue232-'));
// The DB opens asynchronously on require; remove its directory only at exit.
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
process.env.DATABASE_PATH = path.join(tmpDir, 'issue232.db');
process.env.ENCRYPTION_KEY = 'issue232-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const eventsRouter = require('../routes/events');
const tasksRouter = require('../routes/tasks');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

const ATTACKER = 'testuser';
const VICTIM = 'testuser2';
const VICTIM_CAL = `/${VICTIM}/personal/`;
const PAYLOAD_TITLE = 'x<img src=x onerror="window.__pwn=1">';

// Hrefs that a plain posix normalize reads as "/testuser/..." but that the
// request (WHATWG URL resolution, then Radicale's WSGI percent-decoding and
// path sanitizing) delivers to /testuser2/personal/.
const TRAVERSAL_CAL_HREFS = [
  `/${ATTACKER}/%2e%2e/${VICTIM}/personal/`,
  `/${ATTACKER}/%2E%2e/${VICTIM}/personal/`,
  `/${ATTACKER}/..%2f${VICTIM}/personal/`,
  `/${ATTACKER}/..%2F${VICTIM}/personal/`,
  `/${ATTACKER}/%2e%2e%2f${VICTIM}/personal/`
];

function startFakeCalDAV() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end(taskListMultistatus(new URL(req.url, 'http://caldav/').pathname));
      }
      if (req.method === 'PUT') {
        res.writeHead(201, { ETag: '"issue232"' });
        return res.end();
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests })));
}

// Radicale percent-decodes PATH_INFO and strips dot-segments before the rights
// plugin sees it; mirror that to name the collection a request really hits.
function radicaleCollection(url) {
  const decoded = decodeURIComponent(new URL(url, 'http://caldav/').pathname);
  const segs = path.posix.normalize(decoded).split('/').filter(Boolean);
  return '/' + segs.slice(0, 2).join('/') + '/';
}

function startApp(caldavPort) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: ATTACKER,
      accounts: [{
        id: 'internal-caldav',
        url: `http://127.0.0.1:${caldavPort}/${ATTACKER}/`,
        username: ATTACKER,
        password: 'issue232-system-sync-secret'
      }]
    };
    next();
  });
  app.use('/api/events', eventsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/calendars', calendarsRouter);
  return new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('Issue #232 — attacker cannot reach a victim collection through the app', async (t) => {
  await Db.upsertUser(ATTACKER, 'testuser@example.com');
  await Db.upsertUser(VICTIM, 'testuser2@example.com');

  const { server: caldav, requests } = await startFakeCalDAV();
  const appServer = await startApp(caldav.address().port);
  const base = `http://127.0.0.1:${appServer.address().port}`;
  t.after(() => {
    appServer.closeAllConnections(); appServer.close();
    caldav.closeAllConnections(); caldav.close();
  });

  const victimHits = () => requests.filter(r => radicaleCollection(r.url) === VICTIM_CAL);

  await t.test('control: the attacker can still create an event in its own calendar', async () => {
    requests.length = 0;
    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: `internal-caldav::/${ATTACKER}/personal/`,
        title: 'Own event',
        start: '2027-01-15T10:00:00.000Z',
        end: '2027-01-15T11:00:00.000Z'
      })
    });
    assert.equal(res.status, 201, await res.text());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(radicaleCollection(requests[0].url), `/${ATTACKER}/personal/`);
  });

  await t.test('POST /api/events into the victim collection is refused before any CalDAV request', async () => {
    const calendarIds = [
      `internal-caldav::${VICTIM_CAL}`,
      `internal-caldav::http://127.0.0.1:5232${VICTIM_CAL}`,
      ...TRAVERSAL_CAL_HREFS.map(h => `internal-caldav::${h}`)
    ];
    for (const calendarId of calendarIds) {
      requests.length = 0;
      const res = await fetch(`${base}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId,
          title: PAYLOAD_TITLE,
          start: '2027-01-15T10:00:00.000Z',
          end: '2027-01-15T11:00:00.000Z',
          attendees: [{ email: 'testuser2@example.com', name: 'Test User' }]
        })
      });
      assert.ok([400, 403].includes(res.status), `${calendarId}: expected refusal, got ${res.status}`);
      assert.deepEqual(victimHits(), [], `${calendarId}: a CalDAV request reached ${VICTIM_CAL}`);
    }
  });

  // Resource hrefs that must not slip past the per-href check: dot-segment
  // traversals at owner and slug level, a fragment/query/backslash that the
  // request drops or rewrites, undecodable escapes (Radicale keeps "%ZZ"
  // literally, so the item lands in the victim collection) and hrefs above
  // calendar level.
  const VICTIM_RESOURCE_HREFS = [
    ...TRAVERSAL_CAL_HREFS.map(h => `${h}victim-event.ics`),
    `/${ATTACKER}/personal/%2e%2e/%2e%2e/${VICTIM}/personal/victim-event.ics`,
    `/${ATTACKER}/personal/..%2f..%2f${VICTIM}/personal/victim-event.ics`,
    `${VICTIM_CAL}victim-event.ics#/../../../${ATTACKER}/personal/`,
    `${VICTIM_CAL}victim-event.ics?/../../../${ATTACKER}/personal/`,
    `/${ATTACKER}/personal/..\\..\\${VICTIM}/personal/victim-event.ics`,
    `${VICTIM_CAL}victim-event%ZZ.ics`,
    `${VICTIM_CAL}victim-event%E0%A4%A.ics`,
    `/${VICTIM}/`,
    `http://127.0.0.1:5232/${VICTIM}`
  ];

  for (const kind of ['events', 'tasks']) {
    await t.test(`control: PUT and DELETE /api/${kind} still work on the caller's own hrefs`, async () => {
      for (const href of [
        `/${ATTACKER}/personal/own-item.ics`,
        `http://127.0.0.1:5232/${ATTACKER}/personal/own-item.ics`,
        `/${ATTACKER}/personal/own%20item.ics`
      ]) {
        requests.length = 0;
        const put = await fetch(`${base}/api/${kind}/own-item`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calendarId: `internal-caldav::/${ATTACKER}/personal/`,
            href,
            etag: '"x"',
            title: 'Own item',
            start: '2027-01-15T10:00:00.000Z',
            end: '2027-01-15T11:00:00.000Z'
          })
        });
        assert.ok(put.status < 300, `PUT ${href}: got ${put.status} ${await put.text()}`);
        assert.ok(requests.some(r => r.method === 'PUT' && radicaleCollection(r.url) === `/${ATTACKER}/personal/`));

        requests.length = 0;
        const del = await fetch(`${base}/api/${kind}/own-item`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: `internal-caldav::/${ATTACKER}/personal/`, href, etag: '"x"' })
        });
        assert.ok(del.status < 300, `DELETE ${href}: got ${del.status} ${await del.text()}`);
        assert.ok(requests.some(r => r.method === 'DELETE' && radicaleCollection(r.url) === `/${ATTACKER}/personal/`));
      }
    });

    await t.test(`PUT and DELETE /api/${kind} with a victim href are refused before any CalDAV request`, async () => {
      for (const href of VICTIM_RESOURCE_HREFS) {
        requests.length = 0;
        const put = await fetch(`${base}/api/${kind}/victim-event`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calendarId: `internal-caldav::/${ATTACKER}/personal/`,
            href,
            etag: '"x"',
            title: PAYLOAD_TITLE,
            start: '2027-01-15T10:00:00.000Z',
            end: '2027-01-15T11:00:00.000Z'
          })
        });
        assert.ok([400, 403].includes(put.status), `PUT ${href}: expected refusal, got ${put.status}`);
        assert.equal(requests.length, 0, `PUT ${href}: reached CalDAV: ${JSON.stringify(requests)}`);

        const del = await fetch(`${base}/api/${kind}/victim-event`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: `internal-caldav::/${ATTACKER}/personal/`, href, etag: '"x"' })
        });
        assert.ok([400, 403].includes(del.status), `DELETE ${href}: expected refusal, got ${del.status}`);
        assert.equal(requests.length, 0, `DELETE ${href}: reached CalDAV: ${JSON.stringify(requests)}`);
      }
    });
  }

  await t.test('RSVP with a victim href is refused before any CalDAV request', async () => {
    for (const href of VICTIM_RESOURCE_HREFS) {
      requests.length = 0;
      const res = await fetch(`${base}/api/events/victim-event/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: `internal-caldav::/${ATTACKER}/personal/`,
          href,
          email: 'testuser@example.com',
          status: 'ACCEPTED'
        })
      });
      assert.ok([400, 403].includes(res.status), `RSVP ${href}: expected refusal, got ${res.status}`);
      assert.equal(requests.length, 0, `RSVP ${href}: reached CalDAV: ${JSON.stringify(requests)}`);
    }
  });

  // The share route decodes the :id param once more after Express does, so the
  // id must be encoded twice for the percent-escapes to survive into the
  // authorization check (a single encoding arrives as a plain "..").
  const postShare = (calendarId) => fetch(
    `${base}/api/calendars/${encodeURIComponent(encodeURIComponent(calendarId))}/shares`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharee: ATTACKER, readWrite: true })
    }
  );

  await t.test('control: the share route writes a share for a calendar the caller owns', async () => {
    const ownCal = `internal-caldav::/${ATTACKER}/personal/`;
    const res = await postShare(ownCal);
    assert.equal(res.status, 200, await res.text());
    const rows = await Db.getUserShares(ownCal);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'PENDING');
    await Db.removeUserShare(ownCal, ATTACKER);
  });

  await t.test('the attacker cannot grant itself a share on the victim calendar', async () => {
    const calendarIds = [`internal-caldav::${VICTIM_CAL}`, ...TRAVERSAL_CAL_HREFS.map(h => `internal-caldav::${h}`)];
    for (const calendarId of calendarIds) {
      const res = await postShare(calendarId);
      assert.ok([400, 403].includes(res.status), `${calendarId}: expected refusal, got ${res.status}`);
      // getUserShares returns rows of every status, PENDING included.
      assert.deepEqual(await Db.getUserShares(calendarId), [], `${calendarId}: a share row was written`);
    }
  });

  await t.test('a share row stored under a traversal id grants nothing', async () => {
    // Rows like this could be planted while the owner check read the raw href.
    const plantedId = `internal-caldav::/${ATTACKER}/%2e%2e/${VICTIM}/personal/`;
    await Db.addUserShare(plantedId, ATTACKER, true, 'ACCEPTED');
    for (const calendarId of [plantedId, `internal-caldav::${VICTIM_CAL}`]) {
      requests.length = 0;
      const res = await fetch(`${base}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId,
          title: PAYLOAD_TITLE,
          start: '2027-01-15T10:00:00.000Z',
          end: '2027-01-15T11:00:00.000Z'
        })
      });
      assert.ok([400, 403].includes(res.status), `${calendarId}: expected refusal, got ${res.status}`);
      assert.deepEqual(victimHits(), [], `${calendarId}: a CalDAV request reached ${VICTIM_CAL}`);
    }
  });

  await t.test('control: a legitimate ACCEPTED write share still grants writes', async () => {
    // A percent-encoded stored href (Radicale hands those out for slugs with
    // spaces) must keep matching its share.
    const encodedCal = `/${VICTIM}/team%20cal/`;
    for (const calHref of [VICTIM_CAL, encodedCal]) {
      await Db.addUserShare(`internal-caldav::${calHref}`, ATTACKER, true, 'ACCEPTED');
      requests.length = 0;
      const res = await fetch(`${base}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: `internal-caldav::${calHref}`,
          title: 'Shared event',
          start: '2027-01-15T10:00:00.000Z',
          end: '2027-01-15T11:00:00.000Z'
        })
      });
      assert.equal(res.status, 201, `${calHref}: ${await res.text()}`);
      assert.equal(requests.length, 1);
      assert.equal(radicaleCollection(requests[0].url), decodeURIComponent(calHref));
    }

    // The per-href check on an item of the shared calendar uses the share too.
    requests.length = 0;
    const put = await fetch(`${base}/api/events/shared-item`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: `internal-caldav::${encodedCal}`,
        href: `${encodedCal}shared-item.ics`,
        etag: '"x"',
        title: 'Shared item',
        start: '2027-01-15T10:00:00.000Z',
        end: '2027-01-15T11:00:00.000Z'
      })
    });
    assert.ok(put.status < 300, `PUT shared item: got ${put.status} ${await put.text()}`);
  });
});
