'use strict';

/**
 * Issue #174 — Radicale's create cost grows with the collection, so a large first ICS import takes
 * minutes. The import runs as a background job: POST answers at once with the job id and total,
 * and GET /api/calendars/import-jobs/:id reports the loop's real progress (processed of total)
 * while the PUTs are still running, then the outcome. Only the importing user sees the job.
 *
 * The CalDAV server is a fake whose PUTs block until the test releases them (slow backend) or
 * answer 500 (failing backend).
 */
require('./helpers/sameOriginFetch');
process.env.NODE_ENV = 'test';
process.env.PORT = '3375';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const OWNER = 'testuser-174';
const STRANGER = 'testuser-174-other';
const CAL_ID = `internal-caldav::/${OWNER}/personal/`;

function ics(count) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Issue174//EN'];
  for (let i = 0; i < count; i++) {
    lines.push('BEGIN:VEVENT', `UID:issue174-${i}@example.com`, `DTSTART:203601${String(i + 1).padStart(2, '0')}T090000Z`,
      'DURATION:PT1H', `SUMMARY:Test User event ${i}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// Fake CalDAV: REPORT answers an empty calendar; each PUT waits for release() or fails.
function startFakeCalDAV() {
  const state = { mode: 'gated', waiting: [], puts: 0 };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'REPORT' || req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      }
      if (req.method === 'PUT') {
        state.puts++;
        if (state.mode === 'fail') {
          res.writeHead(500);
          return res.end('boom');
        }
        const answer = () => { res.writeHead(201, { ETag: `"e${state.puts}"` }); res.end(); };
        if (state.mode === 'open') return answer();
        return state.waiting.push(answer);
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    state.server = srv;
    state.url = `http://127.0.0.1:${srv.address().port}`;
    // Lets every PUT that is waiting or still arrives through.
    state.openAll = () => { state.mode = 'open'; state.waiting.splice(0).forEach(fn => fn()); };
    state.releaseOne = () => { const fn = state.waiting.shift(); if (fn) fn(); };
    resolve(state);
  }));
}

async function until(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

test('Issue #174 — ICS import runs as a background job with real progress', async (t) => {
  const caldav = await startFakeCalDAV();
  process.env.INTERNAL_CALDAV_URL = caldav.url;
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    caldav.openAll();
    await new Promise(r => server.close(r));
    await new Promise(r => caldav.server.close(r));
    // The server's background timers (backup, retry queue) must not keep the test process alive.
    setImmediate(() => process.exit(process.exitCode || 0));
  });

  await Db.clearAll();
  await Db.upsertUser(OWNER, 'testuser@example.com');
  await Db.upsertUser(STRANGER, 'testuser2@example.com');
  const owner = await loginAs(OWNER);
  const stranger = await loginAs(STRANGER);

  const startImport = (count, cookie = owner) => fetch(`${baseUrl}/api/calendars/${encodeURIComponent(CAL_ID)}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ ics: ics(count), defaultStrategy: 'SKIP' }),
    signal: AbortSignal.timeout(3000)
  });
  const getJob = (id, cookie = owner) => fetch(`${baseUrl}/api/calendars/import-jobs/${encodeURIComponent(id)}`, { headers: { cookie } });

  await t.test('slow backend: POST answers while the PUTs still run, and GET reports processed of total', async () => {
    caldav.mode = 'gated';
    const res = await startImport(3);
    assert.equal(res.status, 202, 'the import must not wait for Radicale');
    const started = await res.json();
    assert.equal(started.total, 3);
    assert.equal(started.status, 'running');
    assert.ok(started.id);

    let job = await (await getJob(started.id)).json();
    assert.equal(job.status, 'running');
    assert.equal(job.total, 3);
    assert.equal(job.processed, 0);

    await until(() => caldav.waiting.length === 1, 'the first PUT');
    caldav.releaseOne();
    job = await until(async () => {
      const j = await (await getJob(started.id)).json();
      return j.processed === 1 ? j : null;
    }, 'processed = 1');
    assert.equal(job.status, 'running', 'two PUTs are still pending');
    assert.equal(job.imported, 1);

    caldav.openAll();
    job = await until(async () => {
      const j = await (await getJob(started.id)).json();
      return j.status === 'done' ? j : null;
    }, 'job done');
    assert.deepEqual({ processed: job.processed, imported: job.imported, skipped: job.skipped, failed: job.failed },
      { processed: 3, imported: 3, skipped: 0, failed: 0 });
  });

  await t.test('another user cannot read the job', async () => {
    caldav.mode = 'open';
    const started = await (await startImport(1)).json();
    const res = await getJob(started.id, stranger);
    assert.equal(res.status, 404);
    const unknown = await getJob('no-such-job');
    assert.equal(unknown.status, 404);
  });

  await t.test('failing backend: every failed PUT is counted, the job still finishes', async () => {
    caldav.mode = 'fail';
    const started = await (await startImport(2)).json();
    const job = await until(async () => {
      const j = await (await getJob(started.id)).json();
      return j.status === 'done' ? j : null;
    }, 'job done');
    assert.deepEqual({ processed: job.processed, imported: job.imported, failed: job.failed },
      { processed: 2, imported: 0, failed: 2 });
  });
});
