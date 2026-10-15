'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #319 — a sharee's delete must not be exported into the owner's external calendar.
 *
 * DELETE /api/events/:uid by a non-owner records the deleted event (path and ICS as stored
 * in Radicale) for every owner id that has a linked external account, so the owner's sync job
 * can put it back before any vdirsyncer / Graph pass runs (sync-worker/sync_worker.py, covered
 * by server/test/python/test_issue319_cross_user_deletion_restore.py).
 * The owner's own delete records nothing. Calendar paths and sessions carry the owner's user id (#144).
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue319-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue319.db');
process.env.ENCRYPTION_KEY = 'issue319-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const eventsRouter = require('../routes/events');

const SHAREE = 'testuser-sharee319';
const EVENT_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:issue319-evt\r\n'
  + 'SUMMARY:Test User meeting\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

let ownerCounter = 0;
// A fresh owner per test, so no record leaks between tests.
// linked: 'caldav' (Basic-auth or Google, both in linked_accounts), 'msgraph' (Microsoft 365) or null.
async function newOwner({ linked = 'caldav' } = {}) {
  ownerCounter += 1;
  const n = String(ownerCounter).padStart(12, '0');
  const owner = { uuid: `31931931-3193-4193-8193-${n}`, name: `testuser-owner319-${ownerCounter}` };
  await Db.upsertUser(owner.uuid, owner.name);
  if (linked === 'caldav') {
    await Db.addAccount(owner.uuid, {
      url: 'https://caldav.example.com/', username: 'testuser', password: 'testuser-password',
    });
  } else if (linked === 'msgraph') {
    await Db.addMSGraphAccount({ userId: owner.uuid, accountEmail: 'testuser@example.com' });
  }
  return owner;
}

// A CalDAV server holding one event; records every request method and path.
async function withDav(fn) {
  const requests = [];
  const dav = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: '"e1"' });
        return res.end(EVENT_ICS);
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${dav.address().port}/`, requests);
  } finally {
    await new Promise((resolve) => dav.close(resolve));
  }
}

async function withApp(session, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = session(); next(); });
  app.use('/api/events', eventsRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function internalAccount(url) {
  return { id: 'internal-caldav', authType: 'basic', url, username: 'testuser', password: 'testuser-password' };
}

// DELETE as `userId`, with the given calendars shared to them read-write.
async function deleteAs(userId, sharedCalendarIds, body) {
  const original = Db.getSharedCalendarsForUser;
  Db.getSharedCalendarsForUser = async (uid) => (uid === SHAREE
    ? sharedCalendarIds.map((calendar_id) => ({ calendar_id, role: 'WRITE', status: 'ACCEPTED', read_write: 1 }))
    : []);
  let requests;
  try {
    await withDav(async (davUrl, reqs) => {
      requests = reqs;
      await withApp(() => ({ userId, accounts: [internalAccount(davUrl)] }), async (base) => {
        const res = await fetch(`${base}/api/events/issue319-evt`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.equal(res.status, 200, await res.text());
      });
    });
  } finally {
    Db.getSharedCalendarsForUser = original;
  }
  assert.ok(requests.some((r) => r.startsWith('DELETE ')), 'the event must be deleted');
  return requests;
}

test.before(async () => {
  await Db.ready;
  await Db.upsertUser(SHAREE, SHAREE);
});

test('a sharee delete records the owner\'s event (path and ICS) before deleting it', async () => {
  const owner = await newOwner();
  const calendarId = `internal-caldav::/${owner.uuid}/cal/`;
  const href = `/${owner.uuid}/cal/issue319-evt.ics`;

  const requests = await deleteAs(SHAREE, [calendarId], { calendarId, href });

  assert.deepEqual(requests.map((r) => r.split(' ')[0]), ['GET', 'DELETE'], 'the event must be read before it is deleted');
  const rows = await Db.getCrossUserDeletions(owner.uuid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].href, href);
  assert.equal(rows[0].ics, EVENT_ICS);
  assert.equal(rows[0].deleted_by, SHAREE);
});

test('a sharee delete addressed through the sharee\'s own calendarId is recorded for the href\'s owner', async () => {
  const owner = await newOwner();
  const ownerCal = `internal-caldav::/${owner.uuid}/cal/`;
  const shareeCal = `internal-caldav::/${SHAREE}/cal/`;
  const href = `/${owner.uuid}/cal/issue319-evt.ics`;

  await deleteAs(SHAREE, [ownerCal], { calendarId: shareeCal, href });

  const rows = await Db.getCrossUserDeletions(owner.uuid);
  assert.equal(rows.length, 1, 'the owner of the deleted event, not of the calendarId, must be protected');
  assert.equal(rows[0].href, href);
});

test('the record is a normalised path, never the caller\'s raw href', async () => {
  const owner = await newOwner();
  const calendarId = `internal-caldav::/${owner.uuid}/cal/`;

  await deleteAs(SHAREE, [calendarId], { calendarId, href: `http://other.example.com/${owner.uuid}/cal/./issue319-evt.ics` });

  const rows = await Db.getCrossUserDeletions(owner.uuid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].href, `/${owner.uuid}/cal/issue319-evt.ics`);
});

test('a sharee delete records nothing for an owner whose only external account is Microsoft 365', async () => {
  // The Graph sync only imports, so it cannot carry the delete out; the sharee's delete stands.
  const owner = await newOwner({ linked: 'msgraph' });
  const calendarId = `internal-caldav::/${owner.uuid}/cal/`;

  const requests = await deleteAs(SHAREE, [calendarId], { calendarId, href: `/${owner.uuid}/cal/issue319-evt.ics` });

  assert.deepEqual(requests.map((r) => r.split(' ')[0]), ['DELETE']);
  assert.deepEqual(await Db.getCrossUserDeletions(owner.uuid), []);
});

test('a sharee delete for an owner without external accounts records nothing', async () => {
  const owner = await newOwner({ linked: null });
  const calendarId = `internal-caldav::/${owner.uuid}/cal/`;

  const requests = await deleteAs(SHAREE, [calendarId], { calendarId, href: `/${owner.uuid}/cal/issue319-evt.ics` });

  assert.deepEqual(requests.map((r) => r.split(' ')[0]), ['DELETE']);
  assert.deepEqual(await Db.getCrossUserDeletions(owner.uuid), [],
    'nothing mirrors the calendar, so a later account link must not resurrect this delete');
});

test('the owner deleting their own event records nothing when the session holds the UUID', async () => {
  const owner = await newOwner();
  const calendarId = `internal-caldav::/${owner.uuid}/cal/`;

  await deleteAs(owner.uuid, [], { calendarId, href: `/${owner.uuid}/cal/issue319-evt.ics` });

  assert.deepEqual(await Db.getCrossUserDeletions(owner.uuid), []);
});
