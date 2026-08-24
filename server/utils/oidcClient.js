'use strict';

const { Issuer } = require('openid-client');

let oidcClient = null;

/**
 * Helper to initialize or retrieve cached OIDC client instance
 */
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

/**
 * Resets cached OIDC client (primarily for testing purposes)
 */
function resetOidcClient() {
  oidcClient = null;
}

module.exports = {
  getOidcClient,
  resetOidcClient
};
