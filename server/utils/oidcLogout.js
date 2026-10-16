'use strict';

// jose v6 is ESM-only; loaded with a dynamic import like openid-client (#179).
const loadJose = () => import('jose');
const { getOidcClient } = require('./oidcClient');

/**
 * Validates an OIDC Back-Channel Logout 1.0 token (JWT) according to RFC 7519 & OIDC Back-Channel Spec.
 * 
 * @param {string} logoutToken - The logout_token JWT string sent by OP
 * @param {Object} [options] - Optional override parameters for verification (key, clientSecret, jwksUri, issuer, audience)
 * @returns {Promise<Object>} The verified JWT payload (claims)
 */
async function verifyLogoutToken(logoutToken, options = {}) {
  if (!logoutToken || typeof logoutToken !== 'string') {
    throw new Error('Missing logout_token');
  }

  const expectedIssuer = options.issuer || process.env.OIDC_ISSUER_URL;
  const expectedAudience = options.audience || process.env.OIDC_CLIENT_ID;

  if (!expectedIssuer || !expectedAudience) {
    throw new Error('OIDC configuration missing');
  }

  const { jwtVerify, decodeProtectedHeader, createRemoteJWKSet } = await loadJose();
  const header = decodeProtectedHeader(logoutToken);
  if (!header || !header.alg || header.alg === 'none') {
    throw new Error('Invalid or missing algorithm in token header');
  }

  let verificationKey = options.key;
  if (!verificationKey) {
    if (header.alg.startsWith('HS')) {
      const secret = options.clientSecret || process.env.OIDC_CLIENT_SECRET;
      if (!secret) throw new Error('OIDC client secret missing for HMAC verification');
      verificationKey = new TextEncoder().encode(secret);
    } else {
      if (options.jwksUri) {
        verificationKey = createRemoteJWKSet(new URL(options.jwksUri));
      } else {
        const { config } = await getOidcClient();
        const { jwks_uri: jwksUri } = config.serverMetadata();
        if (jwksUri) {
          verificationKey = createRemoteJWKSet(new URL(jwksUri));
        } else {
          throw new Error('Unable to determine JWKS endpoint for token verification');
        }
      }
    }
  }

  const { payload } = await jwtVerify(logoutToken, verificationKey, {
    issuer: expectedIssuer,
    audience: expectedAudience,
    clockTolerance: 60
  });

  // OIDC Back-Channel Logout 1.0 Spec Assertions
  if (payload.nonce) {
    throw new Error('logout_token must NOT contain a nonce');
  }

  if (
    !payload.events ||
    typeof payload.events !== 'object' ||
    payload.events['http://schemas.openid.net/event/backchannel-logout'] === undefined
  ) {
    throw new Error('logout_token events claim must contain http://schemas.openid.net/event/backchannel-logout');
  }

  if (!payload.sub && !payload.sid) {
    throw new Error('logout_token must contain sub or sid');
  }

  return payload;
}

module.exports = {
  verifyLogoutToken
};
