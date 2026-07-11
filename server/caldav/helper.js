'use strict';

const CalDAVClient = require('./client');
const Db = require('../db');

/**
 * Instantiate a CalDAVClient for a given account.
 * Automatically checks and refreshes OAuth2 access tokens if near expiration.
 */
async function getClientForAccount(account) {
  if (account.authType !== 'oauth2') {
    return new CalDAVClient({
      url: account.url,
      username: account.username,
      password: account.password,
      authType: 'basic'
    });
  }

  // Refresh token if expired or expiring within 60 seconds
  const isExpired = !account.expiresAt || (account.expiresAt - 60 * 1000 < Date.now());

  if (isExpired) {
    console.log(`[oauth] Access token expired/near expiry for account ${account.id}. Refreshing...`);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) missing in .env');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: account.password, // password field stores the encrypted refresh_token
        grant_type: 'refresh_token'
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google token refresh failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    const accessToken = data.access_token;
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

    // Persist new access token and expiry to SQLite
    await Db.updateOAuthTokens(account.id, { accessToken, expiresAt });
    
    // Update local object referenced in current request context
    account.accessToken = accessToken;
    account.expiresAt = expiresAt;
    console.log(`[oauth] Access token refreshed successfully for account ${account.id}`);
  }

  return new CalDAVClient({
    url: account.url,
    username: account.username,
    password: account.password,
    authType: 'oauth2',
    accessToken: account.accessToken
  });
}

module.exports = { getClientForAccount };
