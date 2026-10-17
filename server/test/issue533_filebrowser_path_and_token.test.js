'use strict';
// Issue #533 — the attachment browser must not forward the session's user id
// as a bearer token, must not write it into stored attachment links, and must
// not let the caller steer the path on the FileBrowser host (`..`, `?`, `#`).
// Production semantics against a loopback FileBrowser stub that records requests.
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const attachmentsRouter = require('../routes/attachments');

const USER_ID = 'testuser-533-id';

const upstream = { requests: [], server: null };

function startApp() {
  const app = express();
  app.use(express.json());
  // The real app mounts the router behind requireAuth; a logged-in session looks like this.
  app.use((req, _res, next) => {
    req.session = { userId: USER_ID, username: 'testuser', accounts: [{ id: 'acc-1' }] };
    next();
  });
  app.use('/api/attachments', attachmentsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Issue #533 — FileBrowser path validation and no user-id token', async (t) => {
  upstream.server = http.createServer((req, res) => {
    upstream.requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [{ name: 'a b#c?.pdf', path: '/docs/a b#c?.pdf', isDir: false, size: 1 }] }));
  });
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.FILEBROWSER_URL;
  process.env.FILEBROWSER_URL = `http://127.0.0.1:${upstream.server.address().port}`;
  const server = await startApp();
  const base = `http://127.0.0.1:${server.address().port}/api/attachments`;
  t.after(() => {
    server.close();
    upstream.server.close();
    if (previousUrl === undefined) delete process.env.FILEBROWSER_URL;
    else process.env.FILEBROWSER_URL = previousUrl;
  });
  t.beforeEach(() => { upstream.requests.length = 0; });

  const rejectedPaths = [
    '/../../x',
    '../x',
    '/docs/..',
    '/docs/./x',
    '/docs?x=1',
    '/docs#frag',
    '/docs\\..\\x',
    '/docs/\u0000x',
  ];
  for (const p of rejectedPaths) {
    await t.test(`listing ${JSON.stringify(p)} is answered 400 without an upstream request`, async () => {
      const res = await fetch(`${base}/filebrowser/files?path=${encodeURIComponent(p)}`);
      assert.equal(res.status, 400);
      assert.equal(upstream.requests.length, 0, 'no request may reach the FileBrowser host');
    });
  }

  await t.test('a repeated path query parameter is answered 400', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=/a&path=/b`);
    assert.equal(res.status, 400);
    assert.equal(upstream.requests.length, 0);
  });

  await t.test('a valid path is listed with each segment percent-encoded', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=${encodeURIComponent('/My Docs/Q&A')}`);
    assert.equal(res.status, 200);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].url, '/api/resources/My%20Docs/Q%26A');
  });

  await t.test('a literal percent sequence is a file name, not an escape the host decodes to ..', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=${encodeURIComponent('/docs/%2e%2e/x')}`);
    assert.equal(res.status, 200);
    assert.equal(upstream.requests[0].url, '/api/resources/docs/%252e%252e/x');
  });

  await t.test('without a caller token the user id is never sent as bearer token', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=/`);
    assert.equal(res.status, 200);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].authorization, undefined);
  });

  await t.test('a caller-supplied bearer token is forwarded unchanged', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=/`, { headers: { Authorization: 'Bearer caller-token' } });
    assert.equal(res.status, 200);
    assert.equal(upstream.requests[0].authorization, 'Bearer caller-token');
  });

  await t.test('a stored attachment link carries neither the user id nor any token', async () => {
    const res = await fetch(`${base}/filebrowser/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller-token' },
      body: JSON.stringify({ filePath: '/docs/plan v2.pdf' }),
    });
    assert.equal(res.status, 200);
    const { attachment } = await res.json();
    assert.equal(attachment.url, `${process.env.FILEBROWSER_URL}/files/docs/plan%20v2.pdf`);
    assert.ok(!attachment.url.includes(USER_ID));
    assert.ok(!attachment.url.includes('caller-token'));
    assert.equal(attachment.name, 'plan v2.pdf');
  });

  for (const p of ['/../../etc/passwd', '/docs?x', '/docs#y', '/docs/\ud800']) {
    await t.test(`linking ${JSON.stringify(p)} is answered 400`, async () => {
      const res = await fetch(`${base}/filebrowser/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: p }),
      });
      assert.equal(res.status, 400);
    });
  }

  await t.test('listed item links are built from encoded upstream paths', async () => {
    const res = await fetch(`${base}/filebrowser/files?path=/docs`);
    assert.equal(res.status, 200);
    const { files } = await res.json();
    assert.equal(files[0].url, `${process.env.FILEBROWSER_URL}/files/docs/a%20b%23c%3F.pdf`);
  });
});
