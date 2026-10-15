'use strict';

/**
 * Issue #263 — Session Cookie & Proxy Production Container Alignment
 * Issue #58  — SESSION_SECRET hardcoded fallback guard
 *
 * Utility to compute Express trust proxy setting and session cookie configuration.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { SqliteSessionStore } = require('./sessionStore');

function getTrustProxySetting(env = process.env) {
  const trustProxyVal = env.TRUST_PROXY;
  if (trustProxyVal !== undefined) {
    if (trustProxyVal === 'true') {
      return true;
    }
    if (trustProxyVal === 'false' || trustProxyVal === '0') {
      return false;
    }
    // A number is a hop count, as in Express ('1' = the one reverse proxy in front, #340).
    if (!isNaN(trustProxyVal) && String(trustProxyVal).trim() !== '') {
      return parseInt(trustProxyVal, 10);
    }
    return trustProxyVal;
  }
  // #340: one hop, the shard's reverse proxy. With `true` req.ip would be the leftmost
  // X-Forwarded-For entry, which the client writes itself (rate limits keyed on req.ip).
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
    return 1;
  }
  return false;
}

// Known weak literals — world-readable in source; session cookies are forgeable if used.
const WEAK_LITERALS = new Set([
  'freeshard-change-this-in-production',
  'freeshard-webcalendar-prod-secret-change-in-env',
  'change-me',
  'portal.id',
  '{{ portal.id }}',
  '{{portal.id}}',
]);

function isWeakSessionSecret(rawSecret, env = process.env) {
  if (!rawSecret) return true;
  const secret = String(rawSecret).trim();
  if (!secret) return true;
  if (WEAK_LITERALS.has(secret)) return true;
  if (/portal\.id/i.test(secret)) return true;
  if (secret.length === 103) return true; // Freeshard rendered portal.id length
  const portalId = (env && env.PORTAL_ID) || process.env.PORTAL_ID;
  if (portalId && secret === portalId.trim()) return true;
  return false;
}

function resolveSessionSecret(env = process.env, targetDbPath) {
  const isProd = env.NODE_ENV === 'production';
  const isStaging = env.NODE_ENV === 'staging';
  const isTest = env.NODE_ENV === 'test';
  const rawSecret = (env.SESSION_SECRET || '').trim();

  // 1. Explicit env secret takes precedence (following the .share_key pattern)
  if (rawSecret) {
    if (isWeakSessionSecret(rawSecret, env)) {
      if ((isProd || isStaging) && env.ALLOW_INSECURE_SESSION_SECRET !== 'true') {
        throw new Error(
          'SESSION_SECRET must be explicitly configured with a secure value in production environment.'
        );
      }
      if (!isProd && !isStaging && !isTest) {
        console.error(
          '[SECURITY WARNING] SESSION_SECRET is not set or uses the hardcoded default. ' +
          'Session cookies are forgeable. Set SESSION_SECRET to a long random string in your .env file.'
        );
      }
    }
    return rawSecret;
  }

  // 2. Secret file next to database
  const dbPathToUse = targetDbPath || env.DATABASE_PATH;
  const dbDir = dbPathToUse ? path.dirname(dbPathToUse) : null;
  const secretFilePath = env.SESSION_SECRET_FILE || (dbDir ? path.join(dbDir, '.session_secret') : null);
  const repoSecretFile = path.resolve(path.join(__dirname, '../../.session_secret'));
  const isRepoSecretFile = secretFilePath && path.resolve(secretFilePath) === repoSecretFile;

  if (secretFilePath && fs.existsSync(secretFilePath)) {
    try {
      const secretFromFile = fs.readFileSync(secretFilePath, 'utf8').trim();
      if (secretFromFile) {
        if (!isWeakSessionSecret(secretFromFile, env)) {
          return secretFromFile;
        }
        // File holds a weak secret or default literal or rendered portal.id
        if ((isProd || isStaging) && env.ALLOW_INSECURE_SESSION_SECRET !== 'true') {
          throw new Error(
            'SESSION_SECRET must be explicitly configured with a secure value in production environment.'
          );
        }
      }
    } catch (err) {
      if (isProd || isStaging) {
        throw err;
      }
    }
  }

  // 3. No secret passed and no file exists:
  // If a database path / secret file path is configured outside the repository root, generate per-install
  if (secretFilePath && !isRepoSecretFile) {
    try {
      const keyDir = path.dirname(secretFilePath);
      if (keyDir && !fs.existsSync(keyDir)) {
        fs.mkdirSync(keyDir, { recursive: true });
      }
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFilePath, generated, { encoding: 'utf8', mode: 0o600 });
      return generated;
    } catch (err) {
      if ((isProd || isStaging) && env.ALLOW_INSECURE_SESSION_SECRET !== 'true') {
        throw new Error(
          'SESSION_SECRET must be explicitly configured with a secure value in production environment.'
        );
      }
    }
  }

  // 4. In production/staging without an explicit secret or per-install database file:
  if ((isProd || isStaging) && env.ALLOW_INSECURE_SESSION_SECRET !== 'true') {
    throw new Error(
      'SESSION_SECRET must be explicitly configured with a secure value in production environment.'
    );
  }

  // 5. In development/other non-test environments:
  if (!isProd && !isStaging && !isTest) {
    console.error(
      '[SECURITY WARNING] SESSION_SECRET is not set or uses the hardcoded default. ' +
      'Session cookies are forgeable. Set SESSION_SECRET to a long random string in your .env file.'
    );
  }

  return 'freeshard-change-this-in-production';
}

function getSessionConfig(env = process.env, options = {}) {
  const isProd = env.NODE_ENV === 'production';

  const sessionSecret = options.secret || resolveSessionSecret(env, options.dbPath);

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
      sameSite: env.COOKIE_SAME_SITE || 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  };
}

module.exports = {
  getTrustProxySetting,
  getSessionConfig,
  resolveSessionSecret,
  isWeakSessionSecret,
  SqliteSessionStore
};
