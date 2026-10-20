'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #614 — disconnecting a linked account (Google, CalDAV, Microsoft 365) or a single linked
// calendar keeps the local mirror as a normal shard calendar, labelled with where it came from, and
// deletes nothing (neither at the provider nor in Radicale). Linking the same account again offers
// to re-attach the kept calendars; accepting points the account's mapping at them again, declining
// leaves them alone. Until the user decides, the mapping row is `detached:<collection>`, which the
// sync workers skip (server/test/python/test_issue614_detached_mirrors.py).
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue614-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue614.db');
process.env.ENCRYPTION_KEY = 'issue614-strong-encryption-key-for-tests-0123456789';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const accountsRouter = require('../routes/accounts');
const msgraphRouter = require('../routes/msgraph');
const Db = require('../db');

const USER = 'u614';
const dbRun = (sql, params = []) => new Promise((res, rej) => Db.db.run(sql, params, err => err ? rej(err) : res()));
const dbAll = (sql, params = []) => new Promise((res, rej) => Db.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

function calendarResponse(href, name) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${name}</d:displayname>`
    + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
}

async function withStack(fn) {
  const davMethods = [];
  const dav = http.createServer((req, res) => {
    davMethods.push(req.method);
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        + calendarResponse(`/${USER}/personal/`, 'Persönlich')
        + calendarResponse(`/${USER}/google-aaaa/`, 'Google Arbeit')
        + calendarResponse(`/${USER}/caldav-bbbb/`, 'Nextcloud Verein')
        + calendarResponse(`/${USER}/msgraph-cccc/`, 'Outlook')
        + '</d:multistatus>');
    });
  });
  await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    const linked = await dbAll('SELECT id FROM linked_accounts WHERE user_id = ?', [USER]);
    req.session = {
      userId: USER,
      accounts: [
        { id: 'internal-caldav', authType: 'basic', url: `http://127.0.0.1:${dav.address().port}/${USER}/`, username: USER, password: 'x' },
        ...linked.map(a => ({ id: a.id }))
      ]
    };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/msgraph', msgraphRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call, davMethods);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
  }
}

async function linkGoogle() {
  const { id } = await Db.addOAuthAccount(USER, {
    url: 'https://apidata.googleusercontent.com/caldav/v2/testuser%40example.com/',
    username: 'testuser@example.com', refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3600000
  });
  return id;
}

async function linkCaldav() {
  const { id } = await Db.addAccount(USER, { url: 'https://cloud.example.com/remote.php/dav/calendars/testuser/', username: 'testuser', password: 'p' });
  return id;
}

async function linkMicrosoft() {
  const { id } = await Db.addMSGraphAccount({ userId: USER, accountEmail: 'testuser@example.com', accessToken: 'a', refreshToken: 'r' });
  return id;
}

async function pairAll() {
  const google = await linkGoogle();
  const caldav = await linkCaldav();
  const graph = await linkMicrosoft();
  await dbRun(`INSERT INTO google_calendar_collections (account_id, user_id, google_calendar_id, local_collection, created_at)
               VALUES (?, ?, 'testuser@example.com', 'google-aaaa', 0)`, [google, USER]);
  await dbRun(`INSERT INTO caldav_calendar_collections (account_id, user_id, remote_collection, local_collection, created_at)
               VALUES (?, ?, 'verein', 'caldav-bbbb', 0)`, [caldav, USER]);
  await dbRun(`INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection, created_at)
               VALUES (?, ?, 'cal-outlook', 'msgraph-cccc', 0)`, [graph, USER]);
  await dbRun(`INSERT INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at, href, local_etag)
               VALUES ('uid-1', 'g1', ?, 0, '/${USER}/msgraph-cccc/uid-1.ics', '"1"')`, [graph]);
  return { google, caldav, graph };
}

async function mapping(table, remote) {
  return dbAll(`SELECT account_id, ${remote} AS remote, local_collection FROM ${table} ORDER BY account_id`);
}

test.beforeEach(async () => {
  await Db.ready;
  for (const table of ['google_calendar_collections', 'caldav_calendar_collections', 'msgraph_calendar_collections',
    'msgraph_event_mappings', 'msgraph_accounts', 'linked_accounts', 'detached_mirrors', 'sync_queue']) {
    await dbRun(`DELETE FROM ${table}`);
  }
  await dbRun('INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)', [USER, USER]);
});

test('Issue #614 — disconnecting the accounts keeps every mirror as a normal, labelled shard calendar', async () => {
  const ids = await pairAll();
  await withStack(async (call, davMethods) => {
    assert.equal((await call('DELETE', `/api/accounts/${ids.google}`)).status, 200);
    assert.equal((await call('DELETE', `/api/accounts/${ids.caldav}`)).status, 200);
    assert.equal((await call('DELETE', `/api/msgraph/accounts/${ids.graph}`)).status, 200);
    // Nothing in Radicale was deleted.
    assert.deepEqual(davMethods.filter(m => m !== 'PROPFIND'), []);

    const { status, body } = await call('GET', '/api/calendars');
    assert.equal(status, 200);
    const byName = Object.fromEntries(body.calendars.map(c => [c.name, {
      formerLink: c.formerLink ?? null, linkedAccountId: c.linkedAccountId, source: c.source, readOnly: !!c.readOnly
    }]));
    const kept = (provider) => ({ provider, accountUsername: provider === 'caldav' ? 'testuser' : 'testuser@example.com' });
    assert.deepEqual(byName, {
      'Persönlich': { formerLink: null, linkedAccountId: null, source: 'local', readOnly: false },
      'Google Arbeit': { formerLink: kept('google'), linkedAccountId: null, source: 'local', readOnly: false },
      'Nextcloud Verein': { formerLink: kept('caldav'), linkedAccountId: null, source: 'local', readOnly: false },
      'Outlook': { formerLink: kept('msgraph'), linkedAccountId: null, source: 'local', readOnly: false },
    });
    // No account is linked again: nothing to offer.
    assert.deepEqual((await call('GET', '/api/accounts/reattach-offers')).body, []);
  });
});

test('Issue #614 — linking the same accounts again offers the kept calendars; accepting re-attaches them without duplicates', async () => {
  const ids = await pairAll();
  await Db.deleteAccount(ids.google);
  await Db.deleteAccount(ids.caldav);
  await Db.deleteMSGraphAccount(ids.graph);
  // A different account is never offered someone else's calendars.
  await Db.addOAuthAccount(USER, { url: 'https://apidata.googleusercontent.com/caldav/v2/other%40example.com/',
    username: 'other@example.com', refreshToken: 'r', accessToken: 'a', expiresAt: 0 });
  const google = await linkGoogle();
  const caldav = await linkCaldav();
  const graph = await linkMicrosoft();

  await withStack(async (call) => {
    const offers = (await call('GET', '/api/accounts/reattach-offers')).body;
    assert.deepEqual(offers.map(o => [o.calendarId, o.provider]).sort(), [
      [`internal-caldav::/${USER}/caldav-bbbb/`, 'caldav'],
      [`internal-caldav::/${USER}/google-aaaa/`, 'google'],
      [`internal-caldav::/${USER}/msgraph-cccc/`, 'msgraph'],
    ]);
    // Until the user decides, the workers skip the remote calendars instead of mirroring them anew.
    assert.deepEqual(await mapping('google_calendar_collections', 'google_calendar_id'),
      [{ account_id: google, remote: 'testuser@example.com', local_collection: 'detached:google-aaaa' }]);

    const accepted = await call('POST', '/api/accounts/reattach-offers', { accept: true });
    assert.deepEqual([accepted.status, accepted.body], [200, { resolved: 3 }]);
    assert.deepEqual(await mapping('google_calendar_collections', 'google_calendar_id'),
      [{ account_id: google, remote: 'testuser@example.com', local_collection: 'google-aaaa' }]);
    assert.deepEqual(await mapping('caldav_calendar_collections', 'remote_collection'),
      [{ account_id: caldav, remote: 'verein', local_collection: 'caldav-bbbb' }]);
    assert.deepEqual(await mapping('msgraph_calendar_collections', 'graph_calendar_id'),
      [{ account_id: graph, remote: 'cal-outlook', local_collection: 'msgraph-cccc' }]);
    // The Microsoft event keeps its pairing, so the next sync matches it instead of copying it.
    assert.deepEqual(await dbAll('SELECT local_uid, graph_id, account_id FROM msgraph_event_mappings'),
      [{ local_uid: 'uid-1', graph_id: 'g1', account_id: graph }]);
    assert.equal((await dbAll('SELECT * FROM sync_queue')).length, 1);

    const { body } = await call('GET', '/api/calendars');
    const outlook = body.calendars.find(c => c.name === 'Outlook');
    assert.equal(outlook.formerLink, undefined);
    assert.equal(outlook.linkedAccountId, graph);
    assert.deepEqual((await call('GET', '/api/accounts/reattach-offers')).body, []);
  });
});

test('Issue #614 — declining keeps the calendars as they are and lets the account mirror anew', async () => {
  const ids = await pairAll();
  await Db.deleteAccount(ids.google);
  const google = await linkGoogle();
  await withStack(async (call) => {
    assert.equal((await call('GET', '/api/accounts/reattach-offers')).body.length, 1);
    assert.deepEqual((await call('POST', '/api/accounts/reattach-offers', { accept: false })).body, { resolved: 1 });
    assert.deepEqual(await mapping('google_calendar_collections', 'google_calendar_id'), []);
    assert.deepEqual((await call('GET', '/api/accounts/reattach-offers')).body, []);
    const { body } = await call('GET', '/api/calendars');
    assert.deepEqual(body.calendars.find(c => c.name === 'Google Arbeit').formerLink,
      { provider: 'google', accountUsername: 'testuser@example.com' });
    assert.notEqual(google, ids.google);
    assert.equal((await call('POST', '/api/accounts/reattach-offers', { accept: 'yes' })).status, 400);
  });
});

test('Issue #614 — a single calendar can be disconnected from a linked account; it is not mirrored again', async () => {
  const ids = await pairAll();
  await withStack(async (call) => {
    assert.equal((await call('POST', '/api/accounts/mirrors/caldav-bbbb/disconnect')).status, 200);
    assert.equal((await call('POST', '/api/accounts/mirrors/personal/disconnect')).status, 404);
    assert.deepEqual(await mapping('caldav_calendar_collections', 'remote_collection'),
      [{ account_id: ids.caldav, remote: 'verein', local_collection: 'detached:caldav-bbbb' }]);
    const { body } = await call('GET', '/api/calendars');
    const verein = body.calendars.find(c => c.name === 'Nextcloud Verein');
    assert.deepEqual([verein.linkedAccountId, verein.formerLink], [null, { provider: 'caldav', accountUsername: 'testuser' }]);
    // The account is still linked: nothing to offer.
    assert.deepEqual((await call('GET', '/api/accounts/reattach-offers')).body, []);

    // Disconnected and linked again later, the account is offered the calendar back.
    await Db.deleteAccount(ids.caldav);
    const caldav = await linkCaldav();
    assert.deepEqual((await call('GET', '/api/accounts/reattach-offers')).body.map(o => o.provider), ['caldav']);
    await call('POST', '/api/accounts/reattach-offers', { accept: true });
    assert.deepEqual(await mapping('caldav_calendar_collections', 'remote_collection'),
      [{ account_id: caldav, remote: 'verein', local_collection: 'caldav-bbbb' }]);
  });
});

test('Issue #614 — a kept calendar deleted afterwards is no longer offered', async () => {
  const ids = await pairAll();
  await Db.deleteAccount(ids.google);
  await Db.deleteCalendarData(`internal-caldav::/${USER}/google-aaaa/`);
  await linkGoogle();
  assert.deepEqual(await Db.getReattachOffers(USER), []);
  assert.deepEqual(await mapping('google_calendar_collections', 'google_calendar_id'), []);
});
