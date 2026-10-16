'use strict';

// openid-client v6 (#179) is ESM-only; a dynamic import loads it from this CommonJS app on every
// supported Node version.
const loadOpenidClient = () => import('openid-client');

let oidcConfig = null;

/**
 * Helper to discover the identity provider once and return the cached openid-client Configuration
 * together with the library's functions. Only https issuers are accepted (openid-client's default).
 * The redirect URI is not part of the configuration: it is derived from BASE_URL per
 * request (#340) and passed to buildAuthorizationUrl()/authorizationCodeGrant() explicitly.
 */
async function getOidcClient() {
  const client = await loadOpenidClient();
  if (oidcConfig) return { client, config: oidcConfig };

  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;

  if (!issuerUrl || !clientId || !clientSecret) {
    throw new Error('OIDC-Konfiguration fehlt in den Umgebungsvariablen (.env)');
  }

  oidcConfig = await client.discovery(new URL(issuerUrl), clientId, clientSecret);
  return { client, config: oidcConfig };
}

/**
 * Resets cached OIDC configuration (primarily for testing purposes)
 */
function resetOidcClient() {
  oidcConfig = null;
}

module.exports = {
  getOidcClient,
  resetOidcClient
};
