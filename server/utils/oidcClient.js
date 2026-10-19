'use strict';

const crypto = require('crypto');
const { parseBaseUrl } = require('./baseUrl');

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
 * #490: the method from OIDC_TOKEN_AUTH_METHOD, else the methods the issuer's discovery metadata
 * offers, client_secret_basic first. An issuer that does not list
 * token_endpoint_auth_methods_supported supports client_secret_basic (RFC 8414 default).
 */
function candidateTokenAuthMethods(serverMetadata, override) {
  if (override) {
    if (!TOKEN_AUTH_METHODS.includes(override)) {
      throw new Error(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}, got '${override}'.`);
    }
    return [override];
  }
  const offered = serverMetadata.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  const methods = TOKEN_AUTH_METHODS.filter((m) => offered.includes(m));
  if (methods.length === 0) {
    throw new Error(`The OIDC issuer offers none of ${TOKEN_AUTH_METHODS.join(', ')} (token_endpoint_auth_methods_supported: ${offered.join(', ')}).`);
  }
  return methods;
}

// #600: the OAuth error code of a token endpoint error response, or null for anything else
// (network failure, malformed response), which the caller rethrows.
function tokenErrorCode(client, err) {
  if (err instanceof client.ResponseBodyError) return err.error;
  if (err instanceof client.WWWAuthenticateChallengeError) {
    return err.cause?.[0]?.parameters?.error || `HTTP ${err.status}`;
  }
  return null;
}

/**
 * #600: the issuer metadata cannot tell which method the client is registered for (Authelia offers
 * both but accepts one per client), so each candidate is tried without a user: a code grant with
 * a deliberately invalid code. `invalid_grant` means the client authentication was accepted; any
 * other answer rejects the method. The first accepted method is used; none accepted is fatal.
 */
async function probeClientAuth(client, serverMetadata, clientId, clientSecret, methods) {
  const params = {
    code: `freeshard-client-auth-check-${crypto.randomBytes(16).toString('hex')}`,
    code_verifier: crypto.randomBytes(32).toString('base64url')
  };
  const baseUrl = parseBaseUrl(process.env);
  if (baseUrl) params.redirect_uri = `${baseUrl}/api/auth/callback`;
  const answers = [];
  for (const method of methods) {
    const clientAuth = method === 'client_secret_basic'
      ? client.ClientSecretBasic(clientSecret)
      : client.ClientSecretPost(clientSecret);
    const config = new client.Configuration(serverMetadata, clientId, clientSecret, clientAuth);
    let answer;
    try {
      await client.genericGrantRequest(config, 'authorization_code', params);
      answer = 'a token for an invalid code';
    } catch (err) {
      answer = tokenErrorCode(client, err);
      if (answer === null) throw err;
    }
    if (answer === 'invalid_grant') {
      console.log(`[oidc] client authentication: ${method} (accepted by ${serverMetadata.token_endpoint})`);
      return config;
    }
    answers.push(`${method}: ${answer}`);
  }
  throw new Error(
    `The OIDC issuer rejects client '${clientId}' with every token endpoint authentication method tried `
    + `(${answers.join('; ')}). Check OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_TOKEN_AUTH_METHOD against the client registration.`
  );
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
  const methods = candidateTokenAuthMethods(serverMetadata, process.env.OIDC_TOKEN_AUTH_METHOD);
  oidcConfig = await probeClientAuth(client, serverMetadata, clientId, clientSecret, methods);
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
