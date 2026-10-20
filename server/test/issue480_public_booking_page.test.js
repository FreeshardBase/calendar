'use strict';

/**
 * Issue #480 — the public booking page is for people outside the shard. In production env mode the
 * page and exactly the files it loads are served under /public/booking/ to a request that carries the
 * proxy secret but no `X-Ptl-Client-Type: terminal` (the store template declares that prefix public,
 * like /api/public/). The rest of the SPA stays behind the terminal check (#143).
 *
 * Exercised by booting the real server process (`node server/index.js`) in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue480-public-booking-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'index.js');
const PROXY_SECRET = 'issue480-proxy-secret-0123456789abcdef0123';

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

function start(port) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    NODE_ENV: 'production',
    AUTH_METHOD: 'env',
    SSL_KEY_PATH: '',
    SSL_CERT_PATH: '',
    DATABASE_PATH: path.join(tmpDir, 'issue480.db'),
    SESSION_SECRET: 'issue480-prod-session-secret-0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SYSTEM_SYNC_SECRET: 'issue480-system-sync-secret-0123456789abcdef',
    INTERNAL_WEBHOOK_SECRET: 'issue480-internal-webhook-secret-0123456789',
    HTTP_HEADER_AUTH_SECRET: PROXY_SECRET,
    BASE_URL: 'https://calendar.shard.example',
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
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
}

// A raw request: fetch() would normalise dot segments away before they reach the server.
function rawGet(base, rawPath, headers) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Anonymous visitors as the platform proxy forwards them: the secret, but no terminal client type.
const ANONYMOUS_VISITORS = [
  { 'X-Freeshard-Secret': PROXY_SECRET },
  { 'X-Freeshard-Secret': PROXY_SECRET, 'X-Ptl-Client-Type': 'anonymous' },
];

let base;
let child;
test.before(async () => {
  const port = await freePort();
  child = await start(port);
  child.removeAllListeners('exit');
  base = `http://127.0.0.1:${port}`;
});
test.after(() => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); }));

test('#480 an anonymous visitor gets the booking page and every file it loads', async () => {
  for (const headers of ANONYMOUS_VISITORS) {
    const pageUrl = `${base}/public/booking/?slug=testuser-consult`;
    const page = await fetch(pageUrl, { headers, redirect: 'manual' });
    assert.equal(page.status, 200, `booking page for ${JSON.stringify(headers)}`);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.getSetCookie().length, 0, 'the public page mints no session');
    const html = await page.text();
    assert.match(html, /id="public-booking-form"/, 'it is the booking page, not the SPA');

    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => new URL(m[1], pageUrl));
    const script = refs.find(u => u.pathname.endsWith('.js'));
    const style = refs.find(u => u.pathname.endsWith('.css'));
    assert.ok(script && style, 'the page loads a script and a stylesheet');

    const js = await fetch(script, { headers });
    assert.equal(js.status, 200, `GET ${script.pathname}`);
    assert.match(js.headers.get('content-type'), /javascript/);
    const jsBody = await js.text();
    assert.match(jsBody, /public-booking-form/, `${script.pathname} is the booking script`);

    const css = await fetch(style, { headers });
    assert.equal(css.status, 200, `GET ${style.pathname}`);
    assert.match(css.headers.get('content-type'), /text\/css/);

    // The modules the booking script imports, and the ones they import (#627: i18n.js and its
    // message catalogues), must be public as well.
    const importsOf = (body, from) => [...body.matchAll(/^import .* from '([^']+)';/gm)].map(m => new URL(m[1], from));
    const imports = importsOf(jsBody, script);
    assert.ok(imports.some(u => u.pathname === '/public/booking/api.js'), 'the booking script imports the API module');
    assert.ok(imports.some(u => u.pathname === '/public/booking/i18n.js'), 'the booking script imports i18n.js');
    const seen = new Set();
    while (imports.length > 0) {
      const mod = imports.shift();
      if (seen.has(mod.pathname)) continue;
      seen.add(mod.pathname);
      const res = await fetch(mod, { headers });
      assert.equal(res.status, 200, `GET ${mod.pathname} (imported by the booking script)`);
      assert.match(res.headers.get('content-type'), /javascript/);
      const body = await res.text();
      if (mod.pathname === '/public/booking/api.js') assert.match(body, /getPublicPage/);
      imports.push(...importsOf(body, mod));
    }
    assert.ok(seen.has('/public/booking/messages/booking.js'), 'the booking page loads its catalogue');
  }
});

test('#480 the rest of the SPA stays behind the terminal check', async () => {
  const privatePaths = ['/', '/index.html', '/js/app.js', '/js/api.js', '/css/app.css', '/booking.html',
    '/public/booking/index.html', '/public/booking/app.js', '/public/booking/nope', '/public/',
    '/public/booking/../../js/app.js', '/public/booking/%2e%2e/%2e%2e/js/app.js', '/public/booking/..%2F..%2Fjs/app.js'];
  for (const headers of ANONYMOUS_VISITORS) {
    for (const p of privatePaths) {
      const res = await rawGet(base, p, headers);
      assert.equal(res.status, 401, `GET ${p} without a terminal must be 401, got ${res.status}`);
    }
  }
});

test('#480 the booking page still needs the proxy secret', async () => {
  const res = await fetch(`${base}/public/booking/`, { headers: { 'X-Ptl-Client-Type': 'anonymous' } });
  assert.equal(res.status, 401);
});
