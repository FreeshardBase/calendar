'use strict';

const express = require('express');
const router = express.Router();
const { Issuer } = require('openid-client');

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

module.exports = router;
