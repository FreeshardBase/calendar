'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('Issue #70 — /mock-dav* endpoint production guard', async (t) => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableMock = process.env.ENABLE_MOCK_DAV;
  const originalSessionSecret = process.env.SESSION_SECRET;
  const originalPort = process.env.PORT;
  const originalSslKey = process.env.SSL_KEY_PATH;
  const originalSslCert = process.env.SSL_CERT_PATH;

  let activeServer = null;

  // #246: production env mode serves only requests carrying the platform proxy secret; every
  // probe carries it, so the production cases measure the mock guard and not the proxy gate.
  const proxySecret = 'mock-dav-proxy-secret-0123456789abcdef0123';
  const originalProxySecret = process.env.HTTP_HEADER_AUTH_SECRET;
  process.env.HTTP_HEADER_AUTH_SECRET = proxySecret;
  t.after(() => {
    if (originalProxySecret !== undefined) process.env.HTTP_HEADER_AUTH_SECRET = originalProxySecret;
    else delete process.env.HTTP_HEADER_AUTH_SECRET;
  });

  t.afterEach(async () => {
    if (activeServer) {
      if (typeof activeServer.closeAllConnections === 'function') {
        activeServer.closeAllConnections();
      }
      await new Promise(resolve => activeServer.close(resolve));
      activeServer = null;
    }
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnableMock !== undefined) {
      process.env.ENABLE_MOCK_DAV = originalEnableMock;
    } else {
      delete process.env.ENABLE_MOCK_DAV;
    }
    if (originalSessionSecret !== undefined) {
      process.env.SESSION_SECRET = originalSessionSecret;
    } else {
      delete process.env.SESSION_SECRET;
    }
    if (originalPort !== undefined) {
      process.env.PORT = originalPort;
    } else {
      delete process.env.PORT;
    }
    if (originalSslKey !== undefined) {
      process.env.SSL_KEY_PATH = originalSslKey;
    } else {
      delete process.env.SSL_KEY_PATH;
    }
    if (originalSslCert !== undefined) {
      process.env.SSL_CERT_PATH = originalSslCert;
    } else {
      delete process.env.SSL_CERT_PATH;
    }
  });

  await t.test('Mounted when NODE_ENV is test', async () => {
    delete require.cache[require.resolve('../index')];
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.SSL_KEY_PATH = '';
    process.env.SSL_CERT_PATH = '';
    delete process.env.ENABLE_MOCK_DAV;
    const { app, server } = require('../index');
    activeServer = server;
    
    // Wait for server to be listening
    if (!server.listening) {
      await new Promise(resolve => server.once('listening', resolve));
    }
    const port = server.address().port;

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/mock-dav/',
        method: 'PROPFIND',
        headers: { 'X-Freeshard-Secret': proxySecret, 'X-Ptl-Client-Type': 'terminal' }
      }, resolve);
      req.on('error', reject);
      req.end();
    });

    let body = '';
    for await (const chunk of res) {
      body += chunk;
    }

    assert.equal(res.statusCode, 207);
    assert.ok(res.headers['content-type']?.includes('text/xml'));
    assert.ok(body.includes('multistatus'));
  });

  await t.test('Not mounted when NODE_ENV is production and ENABLE_MOCK_DAV is not set', async () => {
    delete require.cache[require.resolve('../index')];
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-secure-production-secret-value-12345';
    process.env.PORT = '0';
    process.env.SSL_KEY_PATH = '';
    process.env.SSL_CERT_PATH = '';
    delete process.env.ENABLE_MOCK_DAV;
    const { app, server } = require('../index');
    activeServer = server;

    if (!server.listening) {
      server.listen(0);
      await new Promise(resolve => server.once('listening', resolve));
    }
    const port = server.address().port;

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/mock-dav/',
        method: 'PROPFIND',
        headers: { 'X-Freeshard-Secret': proxySecret, 'X-Ptl-Client-Type': 'terminal' }
      }, resolve);
      req.on('error', reject);
      req.end();
    });

    let body = '';
    for await (const chunk of res) {
      body += chunk;
    }

    // Should NOT return 207 multistatus XML from mock CalDAV handler
    assert.notEqual(res.statusCode, 207);
    assert.ok(!body.includes('<d:multistatus'));
  });

  await t.test('Mounted when NODE_ENV is production but ENABLE_MOCK_DAV is true', async () => {
    delete require.cache[require.resolve('../index')];
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-secure-production-secret-value-12345';
    process.env.PORT = '0';
    process.env.SSL_KEY_PATH = '';
    process.env.SSL_CERT_PATH = '';
    process.env.ENABLE_MOCK_DAV = 'true';
    const { app, server } = require('../index');
    activeServer = server;

    if (!server.listening) {
      server.listen(0);
      await new Promise(resolve => server.once('listening', resolve));
    }
    const port = server.address().port;

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/mock-dav/',
        method: 'PROPFIND',
        headers: { 'X-Freeshard-Secret': proxySecret, 'X-Ptl-Client-Type': 'terminal' }
      }, resolve);
      req.on('error', reject);
      req.end();
    });

    let body = '';
    for await (const chunk of res) {
      body += chunk;
    }

    assert.equal(res.statusCode, 207);
    assert.ok(res.headers['content-type']?.includes('text/xml'));
    assert.ok(body.includes('multistatus'));
  });
});
