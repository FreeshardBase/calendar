'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// Issue #525: the subscription link minted by /api/calendars/:id/public-link must
// not carry the account credential (for internal-caldav that is SYSTEM_SYNC_SECRET),
// and the token must be authenticated so a modified token is rejected before its
// contents are parsed. Runs under NODE_ENV=production against an isolated database,
// a test .share_key file and a local stand-in CalDAV server.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue525-'));
process.env.NODE_ENV = 'production';
process.env.BASE_URL = 'https://calendar.example.com'; // #340: mandatory in production
delete process.env.E2E_TEST;
delete process.env.SHARE_SECRET_KEY; // use the .share_key file next to the database
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, '.encryption_key');
process.env.SYSTEM_SYNC_SECRET = 'issue525-sync-secret';

const SHARE_KEY = crypto.randomBytes(32);
fs.writeFileSync(path.join(tmpDir, '.share_key'), SHARE_KEY);

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
  'UID:public-525@example.com',
  'DTSTAMP:20261001T000000Z',
  'DTSTART:20261020T090000Z',
  'DTEND:20261020T100000Z',
  'SUMMARY:Team Standup',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n') + '\r\n';

// Token layout: hex(nonce) ':' hex(ciphertext) ':' hex(GCM tag), AES-256-GCM.
function openToken(token) {
  const [nonceHex, ctHex, tagHex] = token.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SHARE_KEY, Buffer.from(nonceHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function sealToken(payload, { badTag = false } = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SHARE_KEY, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (badTag) tag[0] ^= 0x01;
  return `${nonce.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

function flipCiphertextByte(token) {
  const [nonceHex, ctHex, tagHex] = token.split(':');
  const ct = Buffer.from(ctHex, 'hex');
  ct[0] ^= 0x01;
  return `${nonceHex}:${ct.toString('hex')}:${tagHex}`;
}

test('Issue #525 — legacy public share token carries no credential and is authenticated (NODE_ENV=production)', async (t) => {
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
    app.use(session({ secret: 'issue525-test-secret', resave: false, saveUninitialized: false }));
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

  const call = (method, url) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'x-harness-user': USER, 'Content-Type': 'application/json' }
  });
  const calPath = `/api/calendars/${encodeURIComponent(CAL_ID)}`;
  const tokenOf = (url) => decodeURIComponent(new URL(url).pathname.match(/\/share\/(.+)\.ics$/)[1]);
  const feed = (token) => fetch(`${baseUrl}/api/public/calendars/share/${token}.ics`);

  let minted;

  await t.test('POST public-link mints a token without username/password that decrypts with the .share_key', async () => {
    const res = await call('POST', `${calPath}/public-link`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    minted = tokenOf(body.url);

    const payload = openToken(minted);
    assert.ok(!('password' in payload), 'token must not carry the account password');
    assert.ok(!('username' in payload), 'token must not carry the account username');
    assert.ok(!JSON.stringify(payload).includes(process.env.SYSTEM_SYNC_SECRET));
    assert.equal(payload.id, 'internal-caldav');
    assert.equal(payload.publicShareId, props['public-share-token']);

    const ics = await feed(minted);
    assert.equal(ics.status, 200);
    assert.ok((await ics.text()).includes('BEGIN:VEVENT'));
  });

  await t.test('GET public-link returns a token without username/password', async () => {
    const res = await call('GET', `${calPath}/public-link`);
    assert.equal(res.status, 200);
    const payload = openToken(tokenOf((await res.json()).url));
    assert.ok(!('password' in payload));
    assert.ok(!('username' in payload));
    assert.equal(payload.publicShareId, props['public-share-token']);
  });

  await t.test('a token with one flipped ciphertext byte fails the integrity check and is rejected', async () => {
    const tampered = flipCiphertextByte(minted);
    assert.throws(() => openToken(tampered), /authenticate/i);
    const res = await feed(tampered);
    assert.equal(res.status, 404);
  });

  await t.test('the server checks the GCM tag: same payload, wrong tag → 404; correct tag → 200', async () => {
    const payload = openToken(minted);
    const forged = await feed(sealToken(payload, { badTag: true }));
    assert.equal(forged.status, 404);
    const genuine = await feed(sealToken(payload));
    assert.equal(genuine.status, 200);
  });

  await t.test('a token whose tag is truncated to 4 bytes is rejected', async () => {
    const payload = openToken(minted);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', SHARE_KEY, nonce, { authTagLength: 4 });
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const short = `${nonce.toString('hex')}:${ct.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
    const res = await feed(short);
    assert.equal(res.status, 404);
  });

  await t.test('disabling the link revokes the token', async () => {
    const off = await call('DELETE', `${calPath}/public-link`);
    assert.equal(off.status, 200);
    const res = await feed(minted);
    assert.equal(res.status, 404);
  });
});
