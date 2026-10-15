'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// Issue #341: the public ICS share must not publish private event details or
// attendee/organizer emails — free/busy only unless the owner picks "full
// details" for that share — and a CalDAV backend failure must answer 5xx
// instead of an empty VCALENDAR (subscribers would delete every event).
// Runs under NODE_ENV=production against an isolated database and a local
// stand-in CalDAV server.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue341-'));
process.env.NODE_ENV = 'production';
process.env.BASE_URL = 'https://calendar.example.com'; // #340: mandatory in production
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, '.encryption_key');
process.env.SHARE_SECRET_KEY = 'issue341-share-secret';
process.env.SYSTEM_SYNC_SECRET = 'issue341-sync-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');

const USER = 'testuser';
const CAL_ID = `internal-caldav::/${USER}/personal/`;

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:public-341@example.com',
  'DTSTAMP:20261001T000000Z',
  'DTSTART:20261020T090000Z',
  'DTEND:20261020T100000Z',
  'SUMMARY:Team Standup',
  'DESCRIPTION:Weekly sync notes',
  'LOCATION:Room 1',
  'ORGANIZER;CN=Test User:mailto:testuser@example.com',
  'ATTENDEE;CN=Test Guest:mailto:testguest@example.com',
  'ATTACH:https://files.example.com/agenda.pdf',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT10M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:private-341@example.com',
  'DTSTAMP:20261001T000000Z',
  'DTSTART:20261021T140000Z',
  'DTEND:20261021T150000Z',
  'CLASS:PRIVATE',
  'SUMMARY:Doctor Appointment',
  'DESCRIPTION:Private diagnosis notes',
  'LOCATION:Private Clinic',
  'ATTACH:https://files.example.com/referral.pdf',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:confidential-341@example.com',
  'DTSTAMP:20261001T000000Z',
  'DTSTART:20261022T140000Z',
  'DTEND:20261022T150000Z',
  'CLASS:CONFIDENTIAL',
  'SUMMARY:Salary Talk',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n') + '\r\n';

const LEAKS_ALWAYS = [
  'testuser@example.com', 'testguest@example.com', 'ATTENDEE', 'ORGANIZER',
  'Doctor Appointment', 'Private diagnosis notes', 'Private Clinic', 'referral.pdf',
  'Salary Talk', 'VALARM'
];
const PUBLIC_DETAILS = ['Team Standup', 'Weekly sync notes', 'Room 1', 'agenda.pdf'];

test('Issue #341 — public ICS share privacy and fail-fast (NODE_ENV=production)', async (t) => {
  let backend = 'ok';
  const props = {};
  let davServer;
  let appServer;
  let baseUrl;

  t.before(async () => {
    davServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.method === 'PROPFIND') {
          const name = (body.match(/<x:([a-z-]+)\/>/) || [])[1];
          const value = props[name];
          res.writeHead(207, { 'Content-Type': 'application/xml' });
          return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:x="http://freeshard.de/ns/"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop>${value ? `<x:${name}>${value}</x:${name}>` : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        }
        if (req.method === 'PROPPATCH') {
          const set = body.match(/<x:([a-z-]+)>([^<]*)<\/x:\1>/);
          if (set) props[set[1]] = set[2];
          const removed = body.includes('<d:remove>') && body.match(/<x:([a-z-]+)\/>/);
          if (removed) delete props[removed[1]];
          res.writeHead(207, { 'Content-Type': 'application/xml' });
          return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
        }
        if (backend === 'down') {
          res.writeHead(503);
          return res.end('backend down');
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/calendar' });
          return res.end(FEED);
        }
        res.writeHead(405);
        res.end();
      });
    });
    await new Promise(resolve => davServer.listen(0, '127.0.0.1', resolve));
    process.env.INTERNAL_CALDAV_URL = `http://127.0.0.1:${davServer.address().port}`;

    await Db.upsertUser(USER, USER, 'testuser@example.com');
    const { protectedRouter, publicRouter } = require('../routes/calendars');

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'issue341-test-secret', resave: false, saveUninitialized: false }));
    // Harness-only identity injection: stands in for the OIDC login.
    app.use((req, res, next) => {
      const who = req.get('x-harness-user');
      if (who) req.session.userId = who;
      next();
    });
    app.use('/api/public/calendars', publicRouter);
    app.use('/api/calendars', protectedRouter);
    await new Promise(resolve => {
      appServer = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${appServer.address().port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (appServer) await new Promise(resolve => appServer.close(resolve));
    if (davServer) await new Promise(resolve => davServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = (method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'x-harness-user': USER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const calPath = `/api/calendars/${encodeURIComponent(CAL_ID)}`;
  const feedPath = (url) => new URL(url).pathname;

  const assertNoLeaks = (ics) => {
    for (const s of LEAKS_ALWAYS) assert.ok(!ics.includes(s), `public feed must not contain "${s}"`);
  };

  await t.test('a new share defaults to free/busy: times only, no titles, emails or private details', async () => {
    backend = 'ok';
    const created = await call('POST', `${calPath}/shares-public`, { label: 'Default Feed' });
    assert.equal(created.status, 201);
    const share = await created.json();
    assert.equal(share.detail, 'busy');

    const res = await fetch(`${baseUrl}${feedPath(share.url)}`);
    assert.equal(res.status, 200);
    const ics = await res.text();
    assertNoLeaks(ics);
    for (const s of PUBLIC_DETAILS) assert.ok(!ics.includes(s), `free/busy feed must not contain "${s}"`);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
    assert.ok(ics.includes('DTSTART:20261020T090000Z'));
    assert.ok(ics.includes('DTSTART:20261021T140000Z'));
  });

  await t.test('a "full" share shows public details but strips emails, attachments of private events and private details', async () => {
    backend = 'ok';
    const created = await call('POST', `${calPath}/shares-public`, { label: 'Full Feed', detail: 'full' });
    assert.equal(created.status, 201);
    const share = await created.json();
    assert.equal(share.detail, 'full');

    const list = await (await call('GET', `${calPath}/shares-public`)).json();
    assert.equal(list.find(s => s.token === share.token).detail, 'full');

    const res = await fetch(`${baseUrl}${feedPath(share.url)}`);
    assert.equal(res.status, 200);
    const ics = await res.text();
    assertNoLeaks(ics);
    for (const s of PUBLIC_DETAILS) assert.ok(ics.includes(s), `full feed must contain "${s}"`);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
    assert.ok(ics.includes('DTSTART:20261021T140000Z'), 'private event still blocks its time');
  });

  await t.test('an unknown detail level is rejected', async () => {
    const created = await call('POST', `${calPath}/shares-public`, { label: 'Bad Feed', detail: 'everything' });
    assert.equal(created.status, 400);
  });

  await t.test('backend failure answers 5xx, never an empty calendar, and is not cached', async () => {
    const created = await call('POST', `${calPath}/shares-public`, { label: 'Outage Feed' });
    const share = await created.json();

    backend = 'down';
    const res = await fetch(`${baseUrl}${feedPath(share.url)}`);
    assert.ok(res.status >= 500 && res.status < 600, `expected 5xx, got ${res.status}`);
    assert.ok(!(await res.text()).includes('BEGIN:VCALENDAR'));

    backend = 'ok';
    const after = await fetch(`${baseUrl}${feedPath(share.url)}`);
    assert.equal(after.status, 200);
    assert.equal(after.headers.get('x-cache'), 'MISS');
    assert.equal(((await after.text()).match(/BEGIN:VEVENT/g) || []).length, 3);
  });

  await t.test('authenticated export also fails with 5xx when the backend is down', async () => {
    backend = 'down';
    const res = await call('GET', `${calPath}/export`);
    assert.ok(res.status >= 500 && res.status < 600, `expected 5xx, got ${res.status}`);
    assert.ok(!(await res.text()).includes('BEGIN:VCALENDAR'));
    backend = 'ok';
  });

  await t.test('subscription link (share dialog) defaults to free/busy and can be switched to full', async () => {
    backend = 'ok';
    const enabled = await (await call('POST', `${calPath}/public-link`)).json();
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.detail, 'busy');

    let ics = await (await fetch(`${baseUrl}${feedPath(enabled.url)}`)).text();
    assertNoLeaks(ics);
    assert.ok(!ics.includes('Team Standup'));

    const bad = await call('PUT', `${calPath}/public-link`, { detail: 'everything' });
    assert.equal(bad.status, 400);

    const updated = await call('PUT', `${calPath}/public-link`, { detail: 'full' });
    assert.equal(updated.status, 200);
    const status = await (await call('GET', `${calPath}/public-link`)).json();
    assert.equal(status.detail, 'full');

    // Same link, served from cache, now reflects the new level.
    ics = await (await fetch(`${baseUrl}${feedPath(enabled.url)}`)).text();
    assertNoLeaks(ics);
    assert.ok(ics.includes('Team Standup'));
  });
});
