'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');

const Db = require('../db');
const authRouter = require('../routes/auth');
const { verifyLogoutToken } = require('../utils/oidcLogout');
const { SqliteSessionStore } = require('../utils/sessionStore');

const TEST_ISSUER = 'http://localhost:9000/auth/realms/test';
const TEST_CLIENT_ID = 'webcalendar-client';
const TEST_CLIENT_SECRET = 'secret-1234567890-secret-1234567890';

// Configure test environment variables
process.env.OIDC_ISSUER_URL = TEST_ISSUER;
process.env.OIDC_CLIENT_ID = TEST_CLIENT_ID;
process.env.OIDC_CLIENT_SECRET = TEST_CLIENT_SECRET;

test.describe('OIDC Back-Channel Logout 1.0 Suite', () => {
  let server;
  let baseUrl;
  let rsaKeys;
  let SignJWT;
  let generateKeyPair;

  test.before(async () => {
    // Generate RSA key pair for testing RS256 token verification
    ({ SignJWT, generateKeyPair } = await import('jose'));
    rsaKeys = await generateKeyPair('RS256');

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const store = new SqliteSessionStore({ db: Db });
    app.use(session({
      secret: 'test-session-secret',
      resave: false,
      saveUninitialized: false,
      store
    }));

    app.use('/api/auth', authRouter);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  test.after(() => {
    if (server) server.close();
  });

  test.describe('verifyLogoutToken Unit Verification', () => {
    test('should verify valid HS256 logout token with sub and sid', async () => {
      const token = await new SignJWT({
        sub: 'user-sub-123',
        sid: 'session-sid-456',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      const payload = await verifyLogoutToken(token);
      assert.equal(payload.sub, 'user-sub-123');
      assert.equal(payload.sid, 'session-sid-456');
      assert.ok(payload.events['http://schemas.openid.net/event/backchannel-logout']);
    });

    test('should verify valid RS256 logout token when explicit key is passed', async () => {
      const token = await new SignJWT({
        sub: 'user-sub-789',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(rsaKeys.privateKey);

      const payload = await verifyLogoutToken(token, { key: rsaKeys.publicKey });
      assert.equal(payload.sub, 'user-sub-789');
    });

    test('should fail validation if nonce is present in token', async () => {
      const token = await new SignJWT({
        sub: 'user-sub-123',
        nonce: 'forbidden-nonce-value',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      await assert.rejects(
        async () => verifyLogoutToken(token),
        (err) => {
          assert.match(err.message, /nonce/i);
          return true;
        }
      );
    });

    test('should fail validation if events claim is missing or invalid', async () => {
      const token = await new SignJWT({
        sub: 'user-sub-123'
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      await assert.rejects(
        async () => verifyLogoutToken(token),
        (err) => {
          assert.match(err.message, /events/i);
          return true;
        }
      );
    });

    test('should fail validation if both sub and sid are missing', async () => {
      const token = await new SignJWT({
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      await assert.rejects(
        async () => verifyLogoutToken(token),
        (err) => {
          assert.match(err.message, /sub or sid/i);
          return true;
        }
      );
    });

    test('should fail validation if issuer does not match', async () => {
      const token = await new SignJWT({
        sub: 'user-sub-123',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('http://untrusted-issuer.example.com')
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      await assert.rejects(
        async () => verifyLogoutToken(token)
      );
    });
  });

  test.describe('POST /api/auth/backchannel-logout HTTP Endpoint', () => {
    test('should return 400 Bad Request when logout_token parameter is missing', async () => {
      const res = await fetch(`${baseUrl}/api/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: ''
      });

      assert.equal(res.status, 400);
      const text = await res.text();
      assert.match(text, /Missing logout_token/i);
    });

    test('should return 400 Bad Request when logout_token is invalid or malformed', async () => {
      const res = await fetch(`${baseUrl}/api/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'logout_token=invalid.jwt.token'
      });

      assert.equal(res.status, 400);
    });

    test('should return 200 OK and purge specific session by sid', async () => {
      const sidToLogout = 'test-sid-target-123';
      const sidToKeep = 'test-sid-keep-456';

      await Db.saveSession(sidToLogout, 'user-id-alpha', { userId: 'user-id-alpha' }, Date.now() + 86400000);
      await Db.saveSession(sidToKeep, 'user-id-beta', { userId: 'user-id-beta' }, Date.now() + 86400000);

      const token = await new SignJWT({
        sid: sidToLogout,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      const res = await fetch(`${baseUrl}/api/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }).toString()
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('pragma'), 'no-cache');

      const targetSession = await Db.getRawSession(sidToLogout);
      assert.equal(targetSession, null);

      const keptSession = await Db.getRawSession(sidToKeep);
      assert.ok(keptSession);

      await Db.deleteSession(sidToKeep);
    });

    test('should return 200 OK and purge all user sessions by sub', async () => {
      const subUser = 'user-sub-multi-777';
      const sid1 = 'user-multi-sid-1';
      const sid2 = 'user-multi-sid-2';
      const sidOther = 'user-other-sid-3';

      await Db.saveSession(sid1, subUser, { userId: subUser }, Date.now() + 86400000);
      await Db.saveSession(sid2, subUser, { userId: subUser }, Date.now() + 86400000);
      await Db.saveSession(sidOther, 'user-other', { userId: 'user-other' }, Date.now() + 86400000);

      const token = await new SignJWT({
        sub: subUser,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} }
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(TEST_CLIENT_SECRET));

      const res = await fetch(`${baseUrl}/api/auth/backchannel-logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: token }).toString()
      });

      assert.equal(res.status, 200);

      const sess1 = await Db.getRawSession(sid1);
      const sess2 = await Db.getRawSession(sid2);
      const sessOther = await Db.getRawSession(sidOther);

      assert.equal(sess1, null);
      assert.equal(sess2, null);
      assert.ok(sessOther);

      await Db.deleteSession(sidOther);
    });
  });
});
