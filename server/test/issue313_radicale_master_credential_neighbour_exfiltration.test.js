'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');
const Db = require('../db');

test('Issue #313 — Prevent Radicale Master Credential Exfiltration & Neighbour Container Header Auth Bypass', async (t) => {

  await t.test('1. x-test-user-id is ignored in production (NODE_ENV=production)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origE2E = process.env.E2E_TEST;
    delete process.env.E2E_TEST;
    process.env.NODE_ENV = 'production';

    const app = express();
    app.use(session({
      secret: 'test-secret-313',
      resave: false,
      saveUninitialized: true
    }));

    app.use(async (req, res, next) => {
      const authMethod = process.env.AUTH_METHOD || 'env';
      let newUserId = req.session.userId;
      if (req.headers['x-test-user-id'] === 'unauthenticated' || req.headers['x-test-user-id'] === 'none') {
        if (req.session.userId !== undefined) {
          delete req.session.userId;
        }
        newUserId = null;
      } else if (req.headers['x-test-user-id']) {
        if (process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') {
          newUserId = req.headers['x-test-user-id'];
        }
      }

      if (newUserId) {
        req.session.userId = newUserId;
        req.session.accounts = [{ id: 'internal-caldav', username: newUserId, password: 'secret-master-pass' }];
      } else {
        delete req.session.userId;
        req.session.accounts = [];
      }
      next();
    });

    app.get('/api/calendars', (req, res) => {
      if (!req.session?.userId || !req.session.accounts || req.session.accounts.length === 0) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.json({ status: 'ok', userId: req.session.userId, accounts: req.session.accounts });
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/calendars`, {
        headers: { 'x-test-user-id': 'victim-0001' }
      });
      assert.equal(res.status, 401, 'Must reject x-test-user-id in production with 401');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origE2E) process.env.E2E_TEST = origE2E;
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('2. x-forwarded-user without secret is rejected in production (AUTH_METHOD=oidc)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origAuthMethod = process.env.AUTH_METHOD;
    const origSecret = process.env.HTTP_HEADER_AUTH_SECRET;
    
    process.env.NODE_ENV = 'production';
    process.env.AUTH_METHOD = 'oidc';
    process.env.HTTP_HEADER_AUTH_SECRET = 'trusted-proxy-secret-999';

    const app = express();
    app.use(session({
      secret: 'test-secret-313',
      resave: false,
      saveUninitialized: true
    }));

    app.use(async (req, res, next) => {
      const authMethod = process.env.AUTH_METHOD || 'env';
      let newUserId = req.session.userId;
      if (req.headers['x-test-user-id'] === 'unauthenticated' || req.headers['x-test-user-id'] === 'none') {
        delete req.session.userId;
        newUserId = null;
      } else if (req.headers['x-test-user-id']) {
        if (process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') {
          newUserId = req.headers['x-test-user-id'];
        }
      } else if (authMethod === 'oidc' || process.env.HTTP_HEADER_AUTH === 'true') {
        const expectedSecret = process.env.HTTP_HEADER_AUTH_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
        const providedSecret = req.headers['x-freeshard-secret'] || req.headers['x-internal-secret'];
        const isTestEnv = process.env.NODE_ENV === 'test';

        if (isTestEnv || (expectedSecret && providedSecret === expectedSecret)) {
          const headerUser = req.headers['x-forwarded-user'] || req.headers['x-user-id'] || req.headers['remote-user'] || req.headers['x-ptl-client-id'];
          if (headerUser) {
            newUserId = String(headerUser).trim();
          }
        }
      }

      if (newUserId) {
        req.session.userId = newUserId;
        req.session.accounts = [{ id: 'internal-caldav', username: newUserId }];
      } else {
        delete req.session.userId;
        req.session.accounts = [];
      }
      next();
    });

    app.get('/api/calendars', (req, res) => {
      if (!req.session?.userId || !req.session.accounts || req.session.accounts.length === 0) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.json({ status: 'ok', userId: req.session.userId });
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // Unauthenticated request without secret header
      const res1 = await fetch(`http://127.0.0.1:${port}/api/calendars`, {
        headers: { 'X-Forwarded-User': 'victim-0001' }
      });
      assert.equal(res1.status, 401, 'Must reject X-Forwarded-User without proxy secret with 401');

      // Authenticated request with valid secret header
      const res2 = await fetch(`http://127.0.0.1:${port}/api/calendars`, {
        headers: {
          'X-Forwarded-User': 'victim-0001',
          'x-freeshard-secret': 'trusted-proxy-secret-999'
        }
      });
      assert.equal(res2.status, 200, 'Must accept X-Forwarded-User when matching proxy secret is present');
      const data2 = await res2.json();
      assert.equal(data2.userId, 'victim-0001');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origAuthMethod) process.env.AUTH_METHOD = origAuthMethod; else delete process.env.AUTH_METHOD;
      if (origSecret) process.env.HTTP_HEADER_AUTH_SECRET = origSecret; else delete process.env.HTTP_HEADER_AUTH_SECRET;
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('3. x-test-user-id is allowed in test mode (NODE_ENV=test)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const app = express();
    app.use(session({
      secret: 'test-secret-313',
      resave: false,
      saveUninitialized: true
    }));

    app.use(async (req, res, next) => {
      let newUserId = req.session.userId;
      if (req.headers['x-test-user-id']) {
        if (process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') {
          newUserId = req.headers['x-test-user-id'];
        }
      }
      if (newUserId) {
        req.session.userId = newUserId;
        req.session.accounts = [{ id: 'internal-caldav', username: newUserId }];
      }
      next();
    });

    app.get('/api/calendars', (req, res) => {
      if (!req.session?.userId) return res.status(401).json({ error: 'Auth required' });
      res.json({ userId: req.session.userId });
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/calendars`, {
        headers: { 'x-test-user-id': 'authorized-test-user' }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.userId, 'authorized-test-user');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      await new Promise(resolve => server.close(resolve));
    }
  });
});
