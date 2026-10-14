'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const indexJsPath = path.resolve(__dirname, '../index.js');
const accountsRoutePath = path.resolve(__dirname, '../routes/accounts.js');
const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

describe('Issue #224 — First request account error handling & onboarding guard', () => {
  const indexJsContent = fs.readFileSync(indexJsPath, 'utf8');
  const accountsRouteContent = fs.readFileSync(accountsRoutePath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('server/index.js account middleware captures accountLoadError on exception', () => {
    assert.ok(
      indexJsContent.includes('req.accountLoadError ='),
      'server/index.js middleware must set req.accountLoadError on account loading failure'
    );
  });

  test('server/routes/accounts.js GET /api/accounts returns 500 when req.accountLoadError is set', () => {
    assert.ok(
      accountsRouteContent.includes('req.accountLoadError'),
      'server/routes/accounts.js must check req.accountLoadError'
    );
    assert.ok(
      /if\s*\(\s*req\.accountLoadError\s*\)[\s\S]*?500/.test(accountsRouteContent),
      'GET /api/accounts must return HTTP 500 when req.accountLoadError is set'
    );
  });

  test('public/js/app.js boot() presents app shell and error toast on AccountsAPI.list() error', () => {
    const bootMatch = appJsContent.match(/async\s+function\s+boot\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(bootMatch, 'boot() function must exist in app.js');

    const bootBody = bootMatch[1];
    const catchMatch = bootBody.match(/catch\s*\(([^)]+)\)\s*\{([\s\S]*?)\}/);
    assert.ok(catchMatch, 'boot() must contain a catch block');

    const catchBody = catchMatch[2];
    assert.ok(catchBody.includes('showApp()'), 'boot() catch block must show app shell');
    assert.ok(catchBody.includes('showToast'), 'boot() catch block must display error toast');
    assert.strictEqual(
      catchBody.includes('showOnboarding()'),
      false,
      'boot() catch block must NOT call showOnboarding()'
    );
  });

  test('Integration test: GET /api/accounts returns HTTP 500 error when middleware account loading fails', async () => {
    const express = require('express');

    const app = express();
    app.use(express.json());

    // Simulate account loading middleware error
    app.use((req, res, next) => {
      req.accountLoadError = 'Database disk I/O error';
      next();
    });

    const accountsRouter = require('../routes/accounts');
    app.use('/api/accounts', accountsRouter);

    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/accounts`);
      assert.strictEqual(res.status, 500, 'Response status must be 500 when account loading failed');
      const json = await res.json();
      assert.ok(json.error, 'Response JSON must contain error property');
      // #160: the root cause is logged by server/index.js, never sent to the client.
      assert.strictEqual(json.error, 'Fehler beim Laden der Kontodaten.');
      assert.ok(!json.error.includes('Database disk I/O error'), 'Root cause must not reach the client');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
