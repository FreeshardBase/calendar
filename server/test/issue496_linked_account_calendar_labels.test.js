'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #496 — the pickers label a linked account's collections with the account's custom name.
// The calendars of a linked account are mirrored into local Radicale collections (`google-<hex>`,
// `caldav-<hex>`); GET /api/calendars must say which linked account each one belongs to, so the
// client can look the account's current name up. A live (non-mirrored) account's calendars belong
// to that account itself.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue496-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue496.db');
process.env.ENCRYPTION_KEY = 'issue496-strong-encryption-key-for-tests-0123456789';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const Db = require('../db');

const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));

function calendarResponse(href, name) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${name}</d:displayname>`
    + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

function multistatus(responses) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses.join('')}</d:multistatus>`;
}

function fakeDav(responses) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(multistatus(responses));
    });
  });
}

async function withStack(fn) {
  const internal = fakeDav([
    calendarResponse('/u496/personal/', 'Persönlich'),
    calendarResponse('/u496/google-0123456789abcdef/', 'testuser@example.com'),
    calendarResponse('/u496/caldav-fedcba9876543210/', 'Team'),
  ]);
  const live = fakeDav([calendarResponse('/live/work/', 'Arbeit')]);
  for (const dav of [internal, live]) await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const internalBase = `http://127.0.0.1:${internal.address().port}`;
  const liveBase = `http://127.0.0.1:${live.address().port}`;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: 'u496',
      accounts: [
        { id: 'internal-caldav', authType: 'basic', url: `${internalBase}/u496/`, username: 'u496', password: 'x' },
        { id: 'acc-live', authType: 'basic', url: `${liveBase}/live/`, username: 'testuser', password: 'x' },
      ]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const dav of [internal, live]) await new Promise(resolve => dav.close(resolve));
  }
}

test('Issue #496 — GET /api/calendars names the linked account each collection belongs to', async () => {
  await Db.ready;
  await dbRun(`INSERT INTO users (user_id, username) VALUES ('u496', 'testuser')`);
  for (const [id, type] of [['acc-google', 'oauth2'], ['acc-dav', 'basic']]) {
    await dbRun(
      `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name, auth_type)
       VALUES (?, 'u496', ?, 'testuser@example.com', 'x', 'x', 'Privat', ?)`, [id, `https://${id}.example.com/`, type]);
  }
  await dbRun(
    `INSERT INTO google_calendar_collections (account_id, user_id, google_calendar_id, local_collection, created_at)
     VALUES ('acc-google', 'u496', 'primary', 'google-0123456789abcdef', 0)`);
  await dbRun(
    `INSERT INTO caldav_calendar_collections (account_id, user_id, remote_collection, local_collection, created_at)
     VALUES ('acc-dav', 'u496', 'team', 'caldav-fedcba9876543210', 0)`);

  await withStack(async (base) => {
    const res = await fetch(`${base}/api/calendars`);
    assert.equal(res.status, 200);
    const { calendars } = await res.json();
    const byName = Object.fromEntries(calendars.map(c => [c.name, c.linkedAccountId]));
    assert.deepEqual(byName, {
      'Persönlich': null,
      'testuser@example.com': 'acc-google',
      'Team': 'acc-dav',
      'Arbeit': 'acc-live',
    });
  });
});
