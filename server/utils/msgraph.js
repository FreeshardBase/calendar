'use strict';

/**
 * Microsoft 365 account connection: OAuth 2.0 authorization code flow with PKCE against the
 * Microsoft identity platform (tenant "common"), #97.
 *
 * Syncing is not done here: sync-worker/msgraph_worker.py is the only Microsoft Graph sync path.
 * It refreshes tokens with the same client credentials and scopes.
 */

const crypto = require('crypto');
const { parseBaseUrl } = require('./baseUrl');

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';
// Must match SCOPES in sync-worker/msgraph_worker.py. The integration only imports, so read access suffices.
const SCOPES = 'offline_access User.Read Calendars.Read';

/**
 * The client registration from the environment, or null when Microsoft 365 is not set up on this
 * shard (an optional integration). The redirect URI derives from BASE_URL only, never from request
 * headers, so without BASE_URL the integration is unavailable too.
 */
function getMSGraphConfig(env = process.env) {
  const clientId = (env.MSGRAPH_CLIENT_ID || '').trim();
  const baseUrl = parseBaseUrl(env);
  if (!clientId || !baseUrl) return null;
  return {
    clientId,
    clientSecret: (env.MSGRAPH_CLIENT_SECRET || '').trim(),
    redirectUri: `${baseUrl}/api/msgraph/callback`,
    baseUrl
  };
}

// A new authorization transaction: state and PKCE verifier stay in the session, the URL goes to the browser.
function createAuthorization(config) {
  const state = crypto.randomBytes(32).toString('base64url');
  // RFC 7636: a 43-character verifier and its S256 challenge.
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const url = new URL(`${AUTHORITY}/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return { url: url.href, transaction: { state, codeVerifier } };
}

async function exchangeAuthorizationCode(config, code, codeVerifier) {
  const params = {
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPES
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  if (!res.ok) {
    throw new Error(`Microsoft token exchange failed (${res.status}): ${await res.text()}`);
  }
  const tokens = await res.json();
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Microsoft token response lacks access_token or refresh_token');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000
  };
}

// The mailbox the tokens belong to, as shown in the account list.
async function fetchAccountEmail(accessToken) {
  const res = await fetch(GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph /me failed (${res.status}): ${await res.text()}`);
  }
  const me = await res.json();
  const email = me.mail || me.userPrincipalName;
  if (!email) throw new Error('Microsoft Graph /me returned neither mail nor userPrincipalName');
  return email;
}

module.exports = {
  SCOPES,
  getMSGraphConfig,
  createAuthorization,
  exchangeAuthorizationCode,
  fetchAccountEmail
};
