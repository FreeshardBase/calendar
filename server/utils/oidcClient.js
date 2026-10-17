'use strict';

// openid-client v6 (#179) is ESM-only; a dynamic import loads it from this CommonJS app on every
// supported Node version.
const loadOpenidClient = () => import('openid-client');

let oidcConfig = null;

// #121: server/index.js checks the same variables at start-up.
const OIDC_CONFIG_MISSING = 'AUTH_METHOD=oidc requires OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.';

// #490: the token endpoint client authentication methods this app can use. server/index.js refuses
// to start with any other OIDC_TOKEN_AUTH_METHOD.
const TOKEN_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'];

/**
 * #490: the method from OIDC_TOKEN_AUTH_METHOD, else from the issuer's discovery metadata:
 * client_secret_basic when offered, otherwise client_secret_post. An issuer that does not list
 * token_endpoint_auth_methods_supported supports client_secret_basic (RFC 8414 default).
 */
function chooseTokenAuthMethod(serverMetadata, override) {
  if (override) {
    if (!TOKEN_AUTH_METHODS.includes(override)) {
      throw new Error(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}, got '${override}'.`);
    }
    return override;
  }
  const offered = serverMetadata.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  const method = TOKEN_AUTH_METHODS.find((m) => offered.includes(m));
  if (!method) {
    throw new Error(`The OIDC issuer offers none of ${TOKEN_AUTH_METHODS.join(', ')} (token_endpoint_auth_methods_supported: ${offered.join(', ')}).`);
  }
  return method;
}

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
    throw new Error(OIDC_CONFIG_MISSING);
  }

  const discovered = await client.discovery(new URL(issuerUrl), clientId, clientSecret);
  const serverMetadata = discovered.serverMetadata();
  const method = chooseTokenAuthMethod(serverMetadata, process.env.OIDC_TOKEN_AUTH_METHOD);
  const clientAuth = method === 'client_secret_basic'
    ? client.ClientSecretBasic(clientSecret)
    : client.ClientSecretPost(clientSecret);
  oidcConfig = new client.Configuration(serverMetadata, clientId, clientSecret, clientAuth);
  return { client, config: oidcConfig };
}

/**
 * Resets cached OIDC configuration (primarily for testing purposes)
 */
function resetOidcClient() {
  oidcConfig = null;
}

module.exports = {
  OIDC_CONFIG_MISSING,
  TOKEN_AUTH_METHODS,
  getOidcClient,
  resetOidcClient
};
