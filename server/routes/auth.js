'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Db = require('../db');
const { getOidcClient } = require('../utils/oidcClient');
const { verifyLogoutToken } = require('../utils/oidcLogout');

// GET /api/auth/session — returns current session status
router.get('/session', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ authenticated: false, error: 'Authentication required' });
  }
  let email = req.session.userEmail || null;
  if (!email && req.session.userId) {
    try {
      email = await Db.getUserEmailByUserId(req.session.userId);
      if (email) req.session.userEmail = email;
    } catch (_) {}
  }
  res.json({
    authenticated: true,
    userId: req.session.userId,
    username: req.session.username || req.session.userId,
    email: email || null
  });
});

// GET /api/auth/login — Redirect user to OIDC identity provider login page
router.get('/login', async (req, res) => {
  try {
    const client = await getOidcClient();
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oidcState = state;
    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[OIDC login error]', err.message);
    res.status(500).send('OIDC-Initialisierung fehlgeschlagen: ' + err.message);
  }
});

// GET /api/auth/callback — OIDC identity provider redirects here with auth code
router.get('/callback', async (req, res) => {
  try {
    const client = await getOidcClient();
    const params = client.callbackParams(req);
    
    const expectedState = req.session.oidcState;
    delete req.session.oidcState;
    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI,
      params,
      { state: expectedState }
    );

    const claims = tokenSet.claims();
    const userId = claims.sub; // Generic OIDC unique user subject
    let username = claims.preferred_username || claims.username || claims.email || claims.name || userId;
    let userEmail = claims.email;

    // Fetch userinfo if preferred_username is missing from the ID Token claims (typical for generic OIDC default policy)
    if ((username === userId || !userEmail) && tokenSet.access_token) {
      try {
        const userinfo = await client.userinfo(tokenSet.access_token);
        username = userinfo.preferred_username || userinfo.username || userinfo.email || userinfo.name || userinfo.sub || username;
        userEmail = userEmail || userinfo.email;
      } catch (uiErr) {
        console.warn('[OIDC callback] Failed to fetch UserInfo claims:', uiErr.message);
      }
    }

    // Persist login to Express session
    req.session.userId = userId;
    req.session.username = username;
    if (userEmail) req.session.userEmail = userEmail;

    // Register mapping in database
    await Db.upsertUser(userId, username, userEmail);

    console.log(`[OIDC callback] Authentifiziert: ${username} (${userId})`);
    res.redirect('/');
  } catch (err) {
    console.error('[OIDC callback error]', err.message);
    res.status(400).send('OIDC-Authentifizierung fehlgeschlagen: ' + err.message);
  }
});

// GET /api/auth/logout — End session locally and redirect
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[OIDC logout error]', err.message);
    }
    res.redirect('/');
  });
});

// GET /api/auth/google — Redirect to Google OAuth2 consent screen
router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
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
    return res.status(400).send('Google OAuth fehlgeschlagen: ' + error);
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
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).send('Nicht autorisiert. Bitte melde dich zuerst an.');
  }

  try {
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
          <script>
            if (window.opener) {
              window.opener.postMessage('google-account-linked', window.location.origin);
            }
            window.close();
          </script>
          Verbindung erfolgreich! Dieses Fenster schließt sich automatisch...
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Google OAuth callback error]', err.message);
    res.status(500).send('Verknüpfung des Google-Kontos fehlgeschlagen: ' + err.message);
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
    return res.status(400).send('Ungültiges logout_token: ' + err.message);
  }
});

module.exports = router;

