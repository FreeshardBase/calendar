'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #338 — stored XSS via `javascript:` attachment URLs; CSP must not allow
// 'unsafe-inline' / 'unsafe-eval' in script-src. Runs with production semantics.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue338-'));
// The DB opens asynchronously on require; remove its directory only at exit.
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
process.env.DATABASE_PATH = path.join(tmpDir, 'issue338.db');
process.env.ENCRYPTION_KEY = 'issue338-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { parseICSToEvent, eventToICS, updateWholeSeries } = require('../utils/ical');
const securityHeaders = require('../utils/securityHeaders');
const eventsRouter = require('../routes/events');

const UNSAFE_URLS = [
  'javascript:alert(document.cookie)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  '//evil.example.com/x'
];

function icsWithAttachments(urls) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Issue338//EN',
    'BEGIN:VEVENT',
    'UID:issue338-attach',
    'DTSTAMP:20270101T000000Z',
    'DTSTART:20270115T100000Z',
    'DTEND:20270115T110000Z',
    'SUMMARY:Foreign invitation',
    ...urls.map(u => `ATTACH;X-FILENAME=file.txt:${u}`),
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

test('Issue #338 — attachment URL scheme allow-list and strict CSP', async (t) => {
  await t.test('parser drops ATTACH values with non-http(s)/mailto schemes from foreign ICS', () => {
    for (const bad of UNSAFE_URLS) {
      const ev = parseICSToEvent(icsWithAttachments([bad, 'https://files.example.com/a.pdf']));
      assert.deepEqual(
        ev.attachments.map(a => a.url),
        ['https://files.example.com/a.pdf'],
        `unsafe ATTACH ${JSON.stringify(bad)} must not reach the client`
      );
    }
  });

  await t.test('parser keeps http, https and mailto attachments', () => {
    const ev = parseICSToEvent(icsWithAttachments([
      'http://files.example.com/a.pdf',
      'https://files.example.com/b.pdf',
      'mailto:testuser@example.com'
    ]));
    assert.deepEqual(ev.attachments.map(a => a.url), [
      'http://files.example.com/a.pdf',
      'https://files.example.com/b.pdf',
      'mailto:testuser@example.com'
    ]);
  });

  await t.test('eventToICS refuses to serialise an unsafe attachment URL', () => {
    assert.throws(() => eventToICS({
      uid: 'issue338-ser',
      title: 'x',
      start: '2027-01-15T10:00:00.000Z',
      end: '2027-01-15T11:00:00.000Z',
      attachments: [{ url: 'javascript:alert(1)', name: 'evil' }]
    }), /attachment URL/i);
  });

  await t.test('updateWholeSeries refuses to write an unsafe attachment URL', () => {
    const existing = icsWithAttachments(['https://files.example.com/a.pdf']);
    assert.throws(() => updateWholeSeries(existing, {
      title: 'x',
      start: '2027-01-15T10:00:00.000Z',
      end: '2027-01-15T11:00:00.000Z',
      attachments: [{ url: 'javascript:alert(1)', name: 'evil' }]
    }), /attachment URL/i);
  });

  await t.test('POST and PUT /api/events reject unsafe attachment URLs with 400', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: 'testuser' }; next(); });
    app.use('/api/events', eventsRouter);
    const server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/events`;
      const post = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: 'acc::/testuser/cal/',
          title: 'x',
          start: '2027-01-15T10:00:00.000Z',
          end: '2027-01-15T11:00:00.000Z',
          attachments: [{ url: 'javascript:alert(1)', name: 'evil' }]
        })
      });
      assert.equal(post.status, 400);
      assert.match((await post.json()).error, /attachment URL/i);

      const put = await fetch(`${base}/issue338`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: 'acc::/testuser/cal/',
          href: '/testuser/cal/issue338.ics',
          title: 'x',
          attachments: [{ url: 'data:text/html,<script>alert(1)</script>' }]
        })
      });
      assert.equal(put.status, 400);
      assert.match((await put.json()).error, /attachment URL/i);
    } finally {
      server.close();
    }
  });

  await t.test("CSP script-src forbids 'unsafe-inline' and 'unsafe-eval'", () => {
    const headers = {};
    securityHeaders({}, { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } }, () => {});
    const csp = headers['content-security-policy'];
    const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src'));
    assert.ok(scriptSrc, 'CSP must declare script-src');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src must not allow 'unsafe-inline': ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src must not allow 'unsafe-eval': ${scriptSrc}`);
    assert.ok(csp.includes("object-src 'none'"));
  });
});
