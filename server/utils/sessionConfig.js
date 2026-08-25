'use strict';

/**
 * Issue #263 — Session Cookie & Proxy Production Container Alignment
 * Issue #58  — SESSION_SECRET hardcoded fallback guard
 *
 * Utility to compute Express trust proxy setting and session cookie configuration.
 */

const { SqliteSessionStore } = require('./sessionStore');

function getTrustProxySetting(env = process.env) {
  const trustProxyVal = env.TRUST_PROXY;
  if (trustProxyVal !== undefined) {
    if (trustProxyVal === 'true' || trustProxyVal === '1') {
      return true;
    }
    if (trustProxyVal === 'false' || trustProxyVal === '0') {
      return false;
    }
    if (!isNaN(trustProxyVal) && String(trustProxyVal).trim() !== '') {
      return parseInt(trustProxyVal, 10);
    }
    return trustProxyVal;
  }
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
    return true;
  }
  return false;
}

function getSessionConfig(env = process.env, options = {}) {
  const sessionSecret = env.SESSION_SECRET || 'freeshard-change-this-in-production';
  const isProd    = env.NODE_ENV === 'production';
  const isStaging = env.NODE_ENV === 'staging';
  const isTest    = env.NODE_ENV === 'test';

  // Known weak literals — world-readable in source; session cookies are forgeable if used.
  const WEAK_LITERALS = new Set([
    'freeshard-change-this-in-production',
    'change-me',
  ]);

  const isWeakSecret = !env.SESSION_SECRET || WEAK_LITERALS.has(env.SESSION_SECRET);

  // Issue #58: production AND staging must refuse to start with a weak secret.
  if (
    (isProd || isStaging) &&
    isWeakSecret &&
    env.ALLOW_INSECURE_SESSION_SECRET !== 'true'
  ) {
    throw new Error(
      'SESSION_SECRET must be explicitly configured with a secure value in production environment.'
    );
  }

  // Issue #58: non-test, non-prod/staging environments warn loudly so operators
  // are not silently running with a forgeable session cookie.
  if (!isProd && !isStaging && !isTest && isWeakSecret) {
    console.error(
      '[SECURITY WARNING] SESSION_SECRET is not set or uses the hardcoded default. ' +
      'Session cookies are forgeable. Set SESSION_SECRET to a long random string in your .env file.'
    );
  }

  let cookieSecure;
  if (env.COOKIE_SECURE !== undefined) {
    if (env.COOKIE_SECURE === 'true') cookieSecure = true;
    else if (env.COOKIE_SECURE === 'false') cookieSecure = false;
    else cookieSecure = env.COOKIE_SECURE;
  } else {
    cookieSecure = isProd ? 'auto' : false;
  }

  const store = options.store || new SqliteSessionStore();

  return {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
      secure: cookieSecure,
      httpOnly: true,
      sameSite: env.COOKIE_SAME_SITE || 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  };
}

module.exports = {
  getTrustProxySetting,
  getSessionConfig,
  SqliteSessionStore
};
