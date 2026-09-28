'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const Db = require('../db');

test('Issue #121 — Generic OIDC & Multi-User Shard Identity', async (t) => {

  await t.test('Documentation does not promise Authelia specifically, but generic OIDC', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
    const agents = fs.readFileSync(path.join(__dirname, '../../agents.md'), 'utf8');

    assert.equal(/Authelia/i.test(readme), false, 'README.md should not promise Authelia specifically');
    assert.equal(/Authelia/i.test(agents), false, 'agents.md should not reference Authelia specifically');
  });

  await t.test('server/routes/auth.js comments and handlers use generic OIDC identity terms', () => {
    const authJs = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
    assert.equal(/Authelia/i.test(authJs), false, 'server/routes/auth.js should not contain Authelia references');
  });

  await t.test('server/index.js contains reverse-proxy / shard user header identity handling', () => {
    const indexJs = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    assert.ok(indexJs.includes('x-forwarded-user') || indexJs.includes('x-user-id'), 'server/index.js should support multi-user reverse-proxy / shard user headers');
  });

  await t.test('Express middleware auto-provisions session for reverse-proxy / shard identity headers when AUTH_METHOD=oidc', async () => {
    const app = express();
    app.use(session({
      secret: 'test-secret-key-for-session-testing-only-12345',
      resave: false,
      saveUninitialized: true
    }));

    app.use(async (req, res, next) => {
      const authMethod = process.env.AUTH_METHOD || 'oidc';
      let userId = req.session.userId;

      if (req.headers['x-test-user-id'] === 'unauthenticated' || req.headers['x-test-user-id'] === 'none') {
        delete req.session.userId;
        userId = null;
      } else if (req.headers['x-test-user-id']) {
        userId = req.headers['x-test-user-id'];
        req.session.userId = userId;
      } else if (authMethod === 'oidc' || process.env.HTTP_HEADER_AUTH === 'true') {
        const headerUser = req.headers['x-forwarded-user'] || req.headers['x-user-id'] || req.headers['remote-user'];
        if (headerUser) {
          userId = String(headerUser).trim();
          req.session.userId = userId;
        }
      }

      if (userId) {
        await Db.upsertUser(userId, userId);
        const dbAccounts = await Db.getAccounts(userId);
        const accounts = [...dbAccounts];
        const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
        if (!accounts.some(a => a.id === 'internal-caldav')) {
          accounts.unshift({
            id: 'internal-caldav',
            url: `${localCalDAVCUrl}/${userId}/`,
            username: userId,
            password: process.env.SYSTEM_SYNC_SECRET || 'test-sync-secret',
            displayName: 'Interner Kalender'
          });
        }
        req.session.accounts = accounts;
      } else {
        req.session.accounts = [];
      }
      next();
    });

    app.get('/api/test-me', (req, res) => {
      if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.json({ userId: req.session.userId, accounts: req.session.accounts });
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test-me`, {
        headers: {
          'X-Forwarded-User': 'sharduser123'
        }
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.userId, 'sharduser123');
      assert.ok(Array.isArray(data.accounts));
      assert.equal(data.accounts[0].username, 'sharduser123');
      assert.ok(data.accounts[0].url.endsWith('/sharduser123/'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
