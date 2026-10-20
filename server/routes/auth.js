'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Db = require('../db');
const { sendError } = require('../utils/errorSanitizer');
const { getOidcClient } = require('../utils/oidcClient');
const { getBaseUrl } = require('../utils/baseUrl');
const { verifyLogoutToken } = require('../utils/oidcLogout');
const { isSafeStorageId } = require('../utils/storageId');

// GET /api/auth/session — returns current session status
router.get('/session', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ authenticated: false, error: 'Authentication required' });
  }
  try {
    let email = req.session.userEmail || null;
    if (!email && req.session.userId) {
      email = await Db.getUserEmailByUserId(req.session.userId);
      if (email) req.session.userEmail = email;
    }
    res.json({
      authenticated: true,
      userId: req.session.userId,
      username: req.session.username || req.session.userId,
      email: email || null
    });
  } catch (err) {
    return sendError(res, err, '[auth SESSION]');
  }
});

// #340: the redirect URIs come from BASE_URL, never from request headers.
const oidcRedirectUri = (req) => `${getBaseUrl(req)}/api/auth/callback`;
const googleRedirectUri = (req) => `${getBaseUrl(req)}/api/auth/google/callback`;

// GET /api/auth/login — Redirect user to OIDC identity provider login page
// #340: authorization code flow with PKCE (S256), nonce and state, all bound to this session.
router.get('/login', async (req, res) => {
  try {
    const { client, config } = await getOidcClient();
    const codeVerifier = client.randomPKCECodeVerifier();
    const transaction = { state: client.randomState(), nonce: client.randomNonce(), codeVerifier };
    req.session.oidc = transaction;
    const params = {
      scope: 'openid profile email',
      redirect_uri: oidcRedirectUri(req),
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256'
    };
    // #535: the first login after a logout must not ride on a provider session that survived it.
    if (req.session.oidcPromptLogin) params.prompt = 'login';
    const authUrl = client.buildAuthorizationUrl(config, params);
    res.redirect(authUrl.href);
  } catch (err) {
    console.error('[OIDC login error]', err.message);
    res.status(500).type('text/plain').send('OIDC-Initialisierung fehlgeschlagen: ' + err.message);
  }
});

// GET /api/auth/callback — OIDC identity provider redirects here with auth code
router.get('/callback', async (req, res) => {
  try {
    const transaction = req.session.oidc;
    delete req.session.oidc;
    // #340: without a login transaction there is nothing to check the response against;
    // accepting it would log the browser into whatever account the code belongs to.
    if (!transaction || !transaction.state || !transaction.nonce || !transaction.codeVerifier) {
      return res.status(400).type('text/plain').send('OIDC-Authentifizierung fehlgeschlagen: keine laufende Anmeldung.');
    }

    const { client, config } = await getOidcClient();
    // The callback URL as the IdP called it, rebuilt on BASE_URL (#340): openid-client reads the
    // response parameters from it and sends it without the query as redirect_uri.
    const callbackUrl = new URL(oidcRedirectUri(req));
    callbackUrl.search = new URL(req.originalUrl, callbackUrl).search;
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.codeVerifier,
      idTokenExpected: true
    });

    const claims = tokens.claims();
    const userId = claims.sub; // Generic OIDC unique user subject
    // #144: the sub is the storage identity (Radicale collection root); refuse, never rewrite.
    if (!isSafeStorageId(userId)) {
      return res.status(401).type('text/plain').send('OIDC-Authentifizierung fehlgeschlagen: ungültige Benutzerkennung.');
    }
    let username = claims.preferred_username || claims.username || claims.email || claims.name || userId;
    let userEmail = claims.email;

    // Fetch userinfo if preferred_username is missing from the ID Token claims (typical for generic OIDC default policy)
    if ((username === userId || !userEmail) && tokens.access_token) {
      try {
        // The subject check refuses a UserInfo response about a different user.
        const userinfo = await client.fetchUserInfo(config, tokens.access_token, userId);
        username = userinfo.preferred_username || userinfo.username || userinfo.email || userinfo.name || userinfo.sub || username;
        userEmail = userEmail || userinfo.email;
      } catch (uiErr) {
        console.warn('[OIDC callback] Failed to fetch UserInfo claims:', uiErr.message);
      }
    }

    // Register mapping in database
    await Db.upsertUser(userId, username, userEmail);

    // #340: a new session id on login, so an id planted before login (fixation) stays anonymous.
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));

    // Persist login to Express session
    req.session.userId = userId;
    req.session.username = username;
    if (userEmail) req.session.userEmail = userEmail;
    // #535: the id_token_hint of the RP-initiated logout.
    req.session.oidcIdToken = tokens.id_token;

    console.log(`[OIDC callback] Authentifiziert: ${username} (${userId})`);
    res.redirect('/');
  } catch (err) {
    // openid-client v6 names the failed check (e.g. a missing nonce claim) in the wrapped cause.
    const reason = err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
    // #490: the provider's error / error_description (e.g. invalid_client) go to the log only; the
    // browser gets the library message above, never provider text.
    // An authorization error response arrives via the callback URL, so any client controls this text:
    // keep it to the RFC 6749 §5.2 charset (no CR/LF, no forged log lines) and cap its length.
    const logSafe = (s) => String(s).replace(/[^\x20-\x21\x23-\x5B\x5D-\x7E]/g, '?').slice(0, 200);
    const providerError = [err, err.cause].find((e) => e && typeof e.error === 'string');
    const providerDetail = providerError
      ? ` (provider error: ${logSafe(providerError.error)}${providerError.error_description ? ` — ${logSafe(providerError.error_description)}` : ''})`
      : '';
    console.error('[OIDC callback error]', reason + providerDetail);
    res.status(400).type('text/plain').send('OIDC-Authentifizierung fehlgeschlagen: ' + reason);
  }
});

// POST /api/auth/logout — End the app session and, with OIDC, the provider's session.
// #340: POST only (a GET could be triggered by an <img>); the CSRF guard checks the origin.
// #535: '/' sends a browser without session straight to the provider, which signs it back in
// while its own session lives. So the browser goes to the provider's end_session_endpoint
// (RP-Initiated Logout 1.0) with the id_token of this login; and the next login requests
// prompt=login, which also covers a provider without end_session_endpoint.
router.post('/logout', async (req, res, next) => {
  const oidc = (process.env.AUTH_METHOD || 'env') === 'oidc';
  const idToken = req.session.oidcIdToken;
  try {
    if (!oidc) {
      await new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
      res.clearCookie('connect.sid');
      return res.redirect(303, '/');
    }
    // A fresh session id without identity; the old session is gone from the store.
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.oidcPromptLogin = true;
    const { client, config } = await getOidcClient();
    if (!config.serverMetadata().end_session_endpoint) return res.redirect(303, '/');
    const params = { post_logout_redirect_uri: getBaseUrl(req) };
    if (idToken) params.id_token_hint = idToken;
    res.redirect(303, client.buildEndSessionUrl(config, params).href);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/google — Redirect to Google OAuth2 consent screen
router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = googleRedirectUri(req);

  if (!clientId) {
    return res.status(500).send('Google OAuth-Konfiguration fehlt in den Umgebungsvariablen (.env)');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/calendar');
  authUrl.searchParams.set('access_type', 'offline'); // Requests refresh_token
  authUrl.searchParams.set('prompt', 'consent'); // Forces consent to guarantee refresh_token is returned
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.href);
});

// GET /api/auth/google/callback — Google redirects here with authorization code
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('[Google OAuth error callback]', error);
    return res.status(400).type('text/plain').send('Google OAuth fehlgeschlagen: ' + error);
  }

  if (!code) {
    return res.status(400).send('Autorisierungscode fehlt.');
  }

  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;
  if (!expectedState || state !== expectedState) {
    return res.status(400).send('Ungültiger OAuth-State. Bitte versuche es erneut.');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).send('Nicht autorisiert. Bitte melde dich zuerst an.');
  }

  try {
    const redirectUri = googleRedirectUri(req);
    // Exchange Auth Code for Access and Refresh Tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Token-Austausch fehlgeschlagen: ${tokenRes.status} ${errText}`);
    }

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in || 3600;

    if (!refreshToken) {
      throw new Error('Kein Refresh-Token erhalten. Bitte trenne den Kalender in deinen Google-Kontoeinstellungen und versuche es erneut.');
    }

    // Get User profile (specifically email address)
    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userinfoRes.ok) {
      throw new Error('Google-Userinfo-Abfrage fehlgeschlagen.');
    }

    const userinfo = await userinfoRes.json();
    const email = userinfo.email;
    const name = userinfo.name || email;

    // Target CalDAV Endpoint (Google Calendar home-set URL)
    const googleCalDAVUrl = `https://apidata.googleusercontent.com/caldav/v2/${email.replace('@', '%40')}/`;

    // Persist as oauth2 account
    await Db.addOAuthAccount(userId, {
      url: googleCalDAVUrl,
      username: email,
      refreshToken,
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      displayName: `Google Kalender (${name})`
    });
    // #614: calendars kept from an earlier link of this account wait for the user's choice.
    await Db.claimDetachedMirrors(userId);

    // Enqueue a sync job immediately to download calendars and events
    try {
      await Db.addSyncJob(userId);
      console.log(`[Google OAuth callback] Enqueued sync job for user ${userId}`);
    } catch (syncErr) {
      console.error(`[Google OAuth callback] Failed to enqueue sync job:`, syncErr.message);
    }

    if (email) {
      if (!req.session.userEmail) req.session.userEmail = email;
      await Db.upsertUser(userId, req.session.username || email, email);
    }

    console.log(`[Google OAuth callback] Google-Konto erfolgreich verknüpft: ${email} für User ${userId}`);

    // Return popup close message
    res.send(`
      <html>
        <body>
          <script src="/js/oauthLinked.js"></script>
          Verbindung erfolgreich! Dieses Fenster schließt sich automatisch...
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Google OAuth callback error]', err.message);
    res.status(500).type('text/plain').send('Verknüpfung des Google-Kontos fehlgeschlagen: ' + err.message);
  }
});

// POST /api/auth/backchannel-logout — OIDC Back-Channel Logout 1.0 endpoint
router.post(['/backchannel-logout', '/backchannel_logout'], express.urlencoded({ extended: true }), async (req, res) => {
  const logoutToken = req.body?.logout_token;
  if (!logoutToken) {
    return res.status(400).send('Missing logout_token');
  }

  try {
    const claims = await verifyLogoutToken(logoutToken);

    if (claims.sid) {
      await Db.deleteSession(claims.sid);
    }
    if (claims.sub) {
      await Db.deleteSessionsForUser(claims.sub);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[Back-Channel Logout error]', err.message);
    return res.status(400).type('text/plain').send('Ungültiges logout_token: ' + err.message);
  }
});

module.exports = router;

