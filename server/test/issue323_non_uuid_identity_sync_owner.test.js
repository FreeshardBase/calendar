'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3323';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

/**
 * Issue #323 — the sync owner must not be derived from a caller-supplied href.
 *
 * With a non-UUID session identity (the shipping shape for env / header / OIDC
 * auth), a caller who owns `/<self>/` could name a victim's UUID as the calendar
 * slug (`/<self>/<victim-uuid>/`). The route-level access check reads
 * segments[0] (the caller → isOwner), while queueSyncForCalendar picked the
 * first UUID-shaped segment anywhere (the victim) and enqueued the victim's sync.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Db = require('../db');
const { server: appServer } = require('../index');
const { queueSyncForCalendar } = require('../utils/calendarAuth');
const { loginAs } = require('./helpers/testSession');

const CALLER = 'testuser-i323';
const VICTIMS = [
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1',
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2',
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa3',
];
const VICTIM = VICTIMS[0];

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, ...options }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForJobs(userId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await Db.getSyncJobs(userId);
    if (jobs.length > 0) return jobs;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`no sync job for ${userId} within ${timeoutMs}ms`);
}

describe('Issue #323 — non-UUID session identity cannot enqueue a victim sync', () => {
  let port;

  before(async () => {
    for (const v of VICTIMS) await Db.upsertUser(v, `testvictim-${v.slice(-1)}`);
    port = Number(process.env.PORT);
    if (!appServer.listening) await new Promise(r => appServer.listen(port, r));
  });

  after(() => { if (appServer.listening) appServer.close(); });

  beforeEach(async () => {
    await Db.clearSyncJobsForUser(CALLER);
    for (const v of VICTIMS) await Db.clearSyncJobsForUser(v);
  });

  test('victim UUID as calendar slug under the caller\'s own path enqueues only the caller', async () => {
    await queueSyncForCalendar(`internal-caldav::/${CALLER}/${VICTIM}/`, CALLER);

    assert.equal((await Db.getSyncJobs(VICTIM)).length, 0, 'victim must not get a sync job');
    const callerJobs = await Db.getSyncJobs(CALLER);
    assert.equal(callerJobs.length, 1, 'caller still gets their own sync job');
    assert.equal(callerJobs[0].userId, CALLER);
  });

  test('absolute href with victim UUID as slug enqueues only the caller', async () => {
    await queueSyncForCalendar(`internal-caldav::http://127.0.0.1:5232/${CALLER}/${VICTIM}/`, CALLER);

    assert.equal((await Db.getSyncJobs(VICTIM)).length, 0);
    assert.equal((await Db.getSyncJobs(CALLER)).length, 1);
  });

  test('cross-tenant fill: several victim slugs enqueue no victim job', async () => {
    for (const v of VICTIMS) {
      await queueSyncForCalendar(`internal-caldav::/${CALLER}/${v}/`, CALLER);
    }
    for (const v of VICTIMS) {
      assert.equal((await Db.getSyncJobs(v)).length, 0, `victim ${v} must not get a sync job`);
    }
    assert.equal((await Db.getSyncJobs(CALLER)).length, 1);
  });

  test('PATCH /api/calendars/:id naming a victim UUID as slug enqueues no victim job', async () => {
    const calendarId = `internal-caldav::/${CALLER}/${VICTIM}/`;
    const res = await request(port, {
      path: `/api/calendars/${encodeURIComponent(calendarId)}`,
      method: 'PATCH',
      headers: { cookie: await loginAs(CALLER), 'Content-Type': 'application/json' },
    }, { name: 'attacker-rename' });
    assert.equal(res.status, 200, res.raw);

    // queueSyncForCalendar is fire-and-forget in the route; once the caller's
    // own row exists the function has finished (the victim row would precede it).
    await waitForJobs(CALLER);
    assert.equal((await Db.getSyncJobs(VICTIM)).length, 0, 'victim must not get a sync job');
  });
});
