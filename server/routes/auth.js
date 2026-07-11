'use strict';

const express = require('express');
const router = express.Router();
const { Issuer } = require('openid-client');
const Db = require('../db');

let oidcClient = null;

// Helper to initialize or retrieve OIDC client
async function getOidcClient() {
  if (oidcClient) return oidcClient;

  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_REDIRECT_URI;

  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
    throw new Error('OIDC-Konfiguration fehlt in den Umgebungsvariablen (.env)');
  }

  const issuer = await Issuer.discover(issuerUrl);
  oidcClient = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ['code']
  });

  return oidcClient;
}

// GET /api/auth/login — Redirect user to Authelia login page
router.get('/login', async (req, res) => {
  try {
    const client = await getOidcClient();
    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state: 'freeshard-session-state' // Simple static state for oauth flow check
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[OIDC login error]', err.message);
    res.status(500).send('OIDC-Initialisierung fehlgeschlagen: ' + err.message);
  }
});

// GET /api/auth/callback — Authelia redirects here with auth code
router.get('/callback', async (req, res) => {
  try {
    const client = await getOidcClient();
    const params = client.callbackParams(req);
    
    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI,
      params,
      { state: 'freeshard-session-state' }
    );

    const claims = tokenSet.claims();
    const userId = claims.sub; // Authelia unique user subject
    const username = claims.preferred_username || claims.username || userId;

    // Persist login to Express session
    req.session.userId = userId;
    req.session.username = username;

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

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/calendar');
  authUrl.searchParams.set('access_type', 'offline'); // Requests refresh_token
  authUrl.searchParams.set('prompt', 'consent'); // Forces consent to guarantee refresh_token is returned
  authUrl.searchParams.set('state', 'google-oauth-state');

  res.redirect(authUrl.href);
});

// GET /api/auth/google/callback — Google redirects here with authorization code
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[Google OAuth error callback]', error);
    return res.status(400).send('Google OAuth fehlgeschlagen: ' + error);
  }

  if (!code) {
    return res.status(400).send('Autorisierungscode fehlt.');
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

    // Target CalDAV Endpoint
    const googleCalDAVUrl = `https://apidata.googleusercontent.com/caldav/v2/${email}/user/`;

    // Persist as oauth2 account
    await Db.addOAuthAccount(userId, {
      url: googleCalDAVUrl,
      username: email,
      refreshToken,
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      displayName: `Google Kalender (${name})`
    });

    console.log(`[Google OAuth callback] Google-Konto erfolgreich verknüpft: ${email} für User ${userId}`);

    // Return popup close message
    res.send(`
      <html>
        <body>
          <script>
            window.opener.postMessage('google-account-linked', '*');
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

module.exports = router;
