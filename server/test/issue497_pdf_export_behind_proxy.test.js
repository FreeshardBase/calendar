'use strict';

/**
 * Issue #497 — "PDF / Druck" behind the platform's reverse proxy.
 *
 * Boots the real server (`node server/index.js`) with NODE_ENV=production and puts a reverse proxy in
 * front of it that behaves like the platform's: it terminates TLS (X-Forwarded-Proto: https), adds the
 * proxy secret and client type, and forwards the browser's Accept-Encoding. The export the browser
 * receives through that proxy must be a complete, valid PDF; a refused export must be JSON, never a file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue497-pdf-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');
const PROXY_SECRET = 'issue497-proxy-secret-0123456789abcdef0123';
const PUBLIC_ORIGIN = 'https://calendar.shard.example';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startApp(port) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    PORT: String(port),
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, 'run.db'),
    SESSION_SECRET: 'issue497-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue497-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue497-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: PROXY_SECRET,
    BASE_URL: PUBLIC_ORIGIN,
    CALDAV_USERNAME: 'testuser',
    CALDAV_EMAIL: 'testuser@example.com',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.includes('running on')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${stderr}`)));
  });
}

// The platform proxy: forwards every request to the app with its identity headers and streams the
// response back unchanged, the way a browser behind it would see it.
function startProxy(appPort) {
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: appPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: new URL(PUBLIC_ORIGIN).host,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': new URL(PUBLIC_ORIGIN).host,
        'x-forwarded-for': '203.0.113.7',
        'x-freeshard-secret': PROXY_SECRET,
        'x-ptl-client-type': 'terminal',
      },
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => { res.destroy(err); });
    req.pipe(upstream);
  });
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy)));
}

// A raw request through the proxy, so the test sees the bytes on the wire (no transparent decoding).
function rawRequest(port, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function decode(res) {
  const enc = res.headers['content-encoding'];
  if (enc === 'gzip') return zlib.gunzipSync(res.body);
  if (enc === 'br') return zlib.brotliDecompressSync(res.body);
  if (enc === 'deflate') return zlib.inflateSync(res.body);
  return res.body;
}

// Structural PDF check: header, every xref entry points at its object, startxref points at the xref
// table, every stream's /Length matches its bytes, and the file ends with %%EOF.
function assertValidPdf(buf) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.'), 'body starts with the PDF header');
  assert.match(s, /%%EOF\s*$/, 'body ends with %%EOF');
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)?.[1]);
  assert.ok(Number.isInteger(startxref), 'trailer names startxref');
  assert.equal(s.slice(startxref, startxref + 4), 'xref', 'startxref points at the xref table');
  const xref = /^xref\n0 (\d+)\n((?:\d{10} \d{5} [fn] \n)+)/.exec(s.slice(startxref));
  assert.ok(xref, 'xref table is well formed');
  const entries = xref[2].trim().split('\n');
  assert.equal(entries.length, Number(xref[1]));
  entries.slice(1).forEach((line, i) => {
    const offset = Number(line.slice(0, 10));
    assert.ok(s.startsWith(`${i + 1} 0 obj`, offset), `xref offset of object ${i + 1} points at it`);
  });
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream', 'stream /Length is exact');
  }
  assert.match(s, /\/Type \/Catalog/);
}

test('Issue #497 — PDF export through the reverse proxy in production', async (t) => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  t.after(() => new Promise((resolve) => { app.removeAllListeners('exit'); app.once('exit', resolve); app.kill('SIGTERM'); }));
  const proxy = await startProxy(appPort);
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const proxyPort = proxy.address().port;

  const session = await rawRequest(proxyPort, { path: '/api/auth/session' });
  assert.equal(session.status, 200, `session handshake through the proxy: ${session.body}`);
  const cookie = session.headers['set-cookie'][0].split(';')[0];

  // What the browser sends: its own headers plus the events it shows, with non-Latin-1 titles.
  const browserHeaders = {
    cookie,
    origin: PUBLIC_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    accept: '*/*',
  };
  const events = [];
  for (let d = 1; d <= 28; d++) {
    for (let h = 8; h < 12; h++) {
      const start = `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
      events.push({ uid: `ev-${d}-${h}@example.com`, calendarId: 'testuser/personal', title: `Termin Übung ${d}/${h} – 🎉 (Raum A)`,
        start, end: start.replace(/T(\d\d)/, (_, x) => `T${String(Number(x) + 1).padStart(2, '0')}`), allDay: false });
    }
  }

  const ranges = { month: ['2026-10-01', '2026-10-31'], week: ['2026-10-12', '2026-10-18'] };
  const calendars = [{ id: 'testuser/personal', name: 'Persönlich', color: '#3b82f6' }];
  for (const view of ['month', 'week']) {
    await t.test(`${view} view: 200, application/pdf attachment, complete valid PDF`, async () => {
      const res = await rawRequest(proxyPort, {
        method: 'POST',
        path: '/api/calendars/export/pdf',
        headers: browserHeaders,
        body: JSON.stringify({ view, from: ranges[view][0], to: ranges[view][1], calendars, events, title: 'Oktober 2026', orientation: 'landscape' }),
      });
      assert.equal(res.status, 200, `export answered ${res.status}: ${res.body.toString('utf8').slice(0, 300)}`);
      assert.match(res.headers['content-type'], /^application\/pdf\b/);
      assert.match(res.headers['content-disposition'], /^attachment; filename="calendar-[a-z]+-\d+\.pdf"$/);
      assert.match(res.headers['cache-control'], /\bno-store\b/, 'a per-user export is never cached by the proxy');
      const pdf = decode(res);
      if (res.headers['content-length'] !== undefined) {
        assert.equal(Number(res.headers['content-length']), res.body.length, 'Content-Length matches the body on the wire');
      }
      assertValidPdf(pdf);
      // The events the browser shows are in the file, not an empty grid.
      assert.ok(pdf.toString('latin1').includes('(Termin \xDCbung 12/10'), 'month and week PDFs show the visible events');
    });
  }

  await t.test('a refused export is a JSON error the client can show, never a PDF attachment', async () => {
    const res = await rawRequest(proxyPort, {
      method: 'POST',
      path: '/api/calendars/export/pdf',
      headers: browserHeaders,
      body: JSON.stringify({ view: 'agenda', from: '2026-10-01', to: '2026-10-31', calendars: [], events: [] }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers['content-type'], /^application\/json\b/);
    assert.equal(res.headers['content-disposition'], undefined);
    assert.ok(JSON.parse(decode(res).toString('utf8')).error);
  });
});
