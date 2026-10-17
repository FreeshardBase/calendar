'use strict';
require('dotenv').config();
const { sendError, describeError } = require('./utils/errorSanitizer');
// Issue #57 fix: NODE_TLS_REJECT_UNAUTHORIZED is no longer set process-wide.
// Per-request TLS bypass for the internal self-signed Radicale server is handled
// exclusively in server/utils/tlsDispatcher.js via a scoped undici Agent.
const { setGlobalDispatcher, Agent } = require('undici');
setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));

// Prevent single async error from killing the process (Express 4 limitation)
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { validateBaseUrl } = require('./utils/baseUrl');
const { isSafeStorageId } = require('./utils/storageId');
const { dispatcherFor } = require('./utils/tlsDispatcher');
const { OIDC_CONFIG_MISSING, TOKEN_AUTH_METHODS } = require('./utils/oidcClient');

function validateSystemSyncSecret(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const isStaging = env.NODE_ENV === 'staging';
  const rawSecret = (env.SYSTEM_SYNC_SECRET || '').trim();
  const legacyBypass = Buffer.from('c3VwZXItc2VjcmV0LWJ5cGFzcw==', 'base64').toString('utf8');
  const weakSecrets = new Set([
    legacyBypass,
    'portal.id',
    '{{ portal.id }}',
    '{{portal.id}}',
    'change-me'
  ]);
  let isWeak = !rawSecret || weakSecrets.has(rawSecret) || /portal\.id/i.test(rawSecret) || rawSecret.length === 103;
  const portalId = (env && env.PORTAL_ID) || process.env.PORTAL_ID;
  if (portalId && rawSecret === portalId.trim()) isWeak = true;

  if ((isProd || isStaging) && isWeak && env.ALLOW_INSECURE_SYSTEM_SYNC_SECRET !== 'true') {
    const msg = 'SYSTEM_SYNC_SECRET must be explicitly configured with a secure value in production environment.';
    if (env.EXIT_ON_INVALID_SECRETS === 'true' || require.main === module) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  }
}

// Issue #340: BASE_URL is the only source of public URLs, OAuth redirect URIs and the CSRF
// origin; the proxy header identity has its own secret, distinct from INTERNAL_WEBHOOK_SECRET.
function validateSecurityConfig(env = process.env) {
  validateBaseUrl(env);
  const isProdLike = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  const headerSecret = (env.HTTP_HEADER_AUTH_SECRET || '').trim();
  if (isProdLike && env.HTTP_HEADER_AUTH === 'true' && !headerSecret) {
    throw new Error('HTTP_HEADER_AUTH=true requires HTTP_HEADER_AUTH_SECRET in production.');
  }
  const authMethod = env.AUTH_METHOD || 'env';
  if (authMethod !== 'env' && authMethod !== 'oidc') {
    throw new Error(`AUTH_METHOD must be 'env' or 'oidc', got '${authMethod}'.`);
  }
  // #523: in oidc mode the identity comes only from the OIDC callback; a header identity is never read.
  if (authMethod === 'oidc' && env.HTTP_HEADER_AUTH === 'true') {
    throw new Error('HTTP_HEADER_AUTH=true is only valid with AUTH_METHOD=env; AUTH_METHOD=oidc takes the identity from the OIDC login.');
  }
  // #121: a missing issuer stops the start-up, not the first login.
  if (authMethod === 'oidc' && !(env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET)) {
    throw new Error(OIDC_CONFIG_MISSING);
  }
  // #490: an unknown token endpoint auth method stops the start-up, not the first login.
  if (authMethod === 'oidc' && env.OIDC_TOKEN_AUTH_METHOD && !TOKEN_AUTH_METHODS.includes(env.OIDC_TOKEN_AUTH_METHOD)) {
    throw new Error(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}, got '${env.OIDC_TOKEN_AUTH_METHOD}'.`);
  }
  // #246: env mode has no login of its own; in production the proxy secret is its only credential.
  if (isProdLike && authMethod === 'env' && !headerSecret) {
    throw new Error('AUTH_METHOD=env requires HTTP_HEADER_AUTH_SECRET (the platform proxy secret) in production.');
  }
  if (isProdLike && headerSecret && headerSecret.length < 32) {
    throw new Error('HTTP_HEADER_AUTH_SECRET must be at least 32 characters in production.');
  }
  for (const other of ['INTERNAL_WEBHOOK_SECRET', 'SYSTEM_SYNC_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY']) {
    if (headerSecret && headerSecret === (env[other] || '').trim()) {
      throw new Error(`HTTP_HEADER_AUTH_SECRET must differ from ${other}.`);
    }
  }
}

// Issue #82: Validate SYSTEM_SYNC_SECRET on server boot before any subsystems load
if (require.main === module || process.env.EXIT_ON_INVALID_SECRETS === 'true') {
  validateSystemSyncSecret(process.env);
  try {
    validateSecurityConfig(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const Db = require('./db');
const { getTrustProxySetting, getSessionConfig } = require('./utils/sessionConfig');
const { createRequireInternalMiddleware, safeCompare } = require('./utils/internalAuth');
const { csrfGuard } = require('./utils/csrfGuard');
const { createRateLimiter, AUTH_RATE_LIMIT, PUBLIC_RATE_LIMIT } = require('./utils/rateLimit');
const securityHeaders = require('./utils/securityHeaders');
const compression = require('./utils/compression');

const defaultDbFilename = process.env.NODE_ENV === 'test' ? '../webcalendar.test.db' : '../webcalendar.db';
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, defaultDbFilename);

const accountsRouter = require('./routes/accounts');
const { protectedRouter: calendarsRouter, publicRouter } = require('./routes/calendars');
const eventsRouter = require('./routes/events');
const tasksRouter = require('./routes/tasks');
const authRouter = require('./routes/auth');
const msgraphRouter = require('./routes/msgraph');
const resourcesRouter = require('./routes/resources');
const availabilityRouter = require('./routes/availability');
const delegatesRouter = require('./routes/delegates');
const workingHoursRouter = require('./routes/workingHours');
const attachmentsRouter = require('./routes/attachments');
const quickAddRouter = require('./routes/quickAdd');
const freebusyRouter = require('./routes/freebusy');
const notificationsRouter = require('./routes/notifications');
const webcalRouter = require('./routes/webcal');
const { startWebcalSyncWorker } = require('./utils/webcalSubscription');
const { startDbBackupWorker } = require('./utils/dbBackup');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', getTrustProxySetting());

// ── Middleware ────────────────────────────────────────────────────────────────
// No request is served before the encryption key has been verified against the database.
app.use((req, res, next) => {
  Db.ready.then(() => next(), next);
});
app.use(compression());
app.use(securityHeaders);

// #340: the proxy's own secret (never INTERNAL_WEBHOOK_SECRET), compared in constant time.
function hasProxySecret(req) {
  const expectedSecret = process.env.HTTP_HEADER_AUTH_SECRET;
  const providedSecret = req.headers['x-freeshard-secret'] || req.headers['x-internal-secret'];
  return Boolean(expectedSecret) && safeCompare(providedSecret, expectedSecret);
}

// #480: the public booking page and exactly the files it loads, for visitors outside the shard. The
// store template declares /public/booking/ public next to /api/public/. Only these exact paths pass the
// terminal check below, so dot segments or other names under the prefix stay private.
const PUBLIC_BOOKING_FILES = new Map([
  ['/public/booking/', 'booking.html'],
  ['/public/booking/booking.js', 'js/booking.js'],
  ['/public/booking/api.js', 'js/api.js'],
  ['/public/booking/app.css', 'css/app.css'],
]);
const isPublicPath = (req) => req.path.startsWith('/api/public/') || PUBLIC_BOOKING_FILES.has(req.path);

// #246: in production, AUTH_METHOD=env serves only requests that come through the FreeShard
// platform proxy. Exempt: the container healthcheck and /internal/ (own INTERNAL_WEBHOOK_SECRET).
app.use((req, res, next) => {
  const isProdLike = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  if (!isProdLike || (process.env.AUTH_METHOD || 'env') !== 'env') return next();
  if (req.path === '/health' || req.path === '/api/health' || req.path.startsWith('/internal/')) return next();
  if (!hasProxySecret(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // #143: the proxy's access decision is checked here too. app_meta.json declares
  // X-Ptl-Client-Type: {{ auth.client_type }}; only a paired terminal reaches the private paths.
  if (!isPublicPath(req) && req.headers['x-ptl-client-type'] !== 'terminal') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
});

// #164: express.static percent-decodes the path, so /api/x/..%2F.. would resolve to public/ and be
// answered with index.html. API paths never reach it; they end at a router or the JSON 404 below.
const isApiPath = (req) =>
  req.path.split('/').filter(seg => seg !== '' && seg !== '.')[0]?.toLowerCase() === 'api';
// #172: only the API and the page itself use the session. Static assets, 304s and the SPA fallback
// skip the session store and the account loader, so they cost no database read or write.
const usesSession = (req) => isApiPath(req) || req.path === '/' || req.path === '/index.html';
const sessionConfig = getSessionConfig();
const sessionMiddleware = session(sessionConfig);
// #491: express-session restores the cookie options stored with each session, so a session created
// under another COOKIE_SAME_SITE would keep re-issuing its old SameSite. The configured value wins.
const withSession = (req, res, next) => sessionMiddleware(req, res, (err) => {
  if (err) return next(err);
  req.session.cookie.sameSite = sessionConfig.cookie.sameSite;
  next();
});
app.use((req, res, next) => (usesSession(req) ? withSession(req, res, next) : next()));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// #526: req.session.accounts holds decrypted credentials and SYSTEM_SYNC_SECRET. It is rebuilt from
// the database on every request and attached non-enumerable, so neither the session store
// (JSON.stringify → sessions.sess, copied into backups) nor express-session's change hash sees it.
function setSessionAccounts(req, accounts) {
  Object.defineProperty(req.session, 'accounts', { value: accounts, writable: true, configurable: true, enumerable: false });
}

// ── Middleware to load accounts from SQLite database into req.session.accounts ──
app.use(async (req, res, next) => {
  if (!usesSession(req)) return next();
  const authMethod = process.env.AUTH_METHOD || 'env';
  // #50/#245: identity comes only from the session or the secret-gated proxy headers below.
  // #523: in oidc mode only the OIDC callback sets the identity; the proxy headers are env-mode only.
  let newUserId = req.session.userId;
  let fromHeader = false;
  if (authMethod === 'env' && process.env.HTTP_HEADER_AUTH === 'true') {
    if (hasProxySecret(req)) {
      const headerUser = req.headers['x-forwarded-user'] || req.headers['x-user-id'] || req.headers['remote-user'];
      if (headerUser) {
        newUserId = String(headerUser).trim();
        fromHeader = true;
        // #523: a new identity never inherits the previous (or an anonymous) session.
        if (req.session.userId !== newUserId) {
          try {
            await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
          } catch (err) {
            return next(err);
          }
        }
      }
      const headerEmail = req.headers['x-forwarded-email'] || req.headers['remote-email'] || req.headers['x-user-email'];
      if (headerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(headerEmail).trim())) {
        req.session.userEmail = String(headerEmail).trim().toLowerCase();
      } else if (headerUser && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(headerUser).trim())) {
        req.session.userEmail = String(headerUser).trim().toLowerCase();
      }
    }
  } else if (!newUserId && authMethod === 'env' && (req.path === '/' || req.path === '/index.html' || req.path === '/api/auth/session')) {
    newUserId = process.env.CALDAV_USERNAME || 'test';
    if (process.env.CALDAV_EMAIL) {
      req.session.userEmail = process.env.CALDAV_EMAIL.trim().toLowerCase();
    } else if (process.env.CALDAV_USERNAME && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.CALDAV_USERNAME.trim())) {
      req.session.userEmail = process.env.CALDAV_USERNAME.trim().toLowerCase();
    }
  }

  // #144: the user id is the storage identity and names the Radicale collection root. From the OIDC
  // session or the proxy header it is refused unless it is a safe path segment.
  if ((authMethod === 'oidc' || fromHeader) && newUserId && !isSafeStorageId(newUserId)) {
    delete req.session.userId;
    setSessionAccounts(req, []);
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (newUserId && req.session.userId !== newUserId) {
    req.session.userId = newUserId;
  }
  const userId = newUserId;

  if (userId) {
    try {
      if (!req.session.userEmail) {
        const dbEmail = await Db.getUserEmailByUserId(userId);
        if (dbEmail) req.session.userEmail = dbEmail;
      }
      if (req.session.userUpserted !== userId) {
        await Db.upsertUser(userId, (req.session && req.session.username) || userId, req.session.userEmail || null);
        if (process.env.NODE_ENV === 'test') {
          await Db.upsertUser('testuser-id', 'testuser@example.com', 'testuser@example.com');
        }
        req.session.userUpserted = userId;
      }
      const dbAccounts = await Db.getAccounts(userId);
      const accounts = [...dbAccounts];
      
      // Merge with env-default if env-default is configured and not in database
      const hasCalDAVEnv = process.env.CALDAVURL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD;
      if (
        (hasCalDAVEnv || (process.env.NODE_ENV === 'test' && process.env.DISABLE_INTERNAL_CALDAV)) &&
        !accounts.some(a => a.id === 'env-default')
      ) {
        accounts.unshift({
          id: 'env-default',
          url: process.env.CALDAVURL || 'http://localhost:1080/users/test/calendars/',
          username: process.env.CALDAV_USERNAME || 'test',
          password: process.env.CALDAV_PASSWORD || 'password',
          displayName: process.env.ACCOUNT_DISPLAY_NAME || process.env.CALDAV_USERNAME || 'test'
        });
      }

      // Inject the internal CalDAV account (Radicale) unless disabled. #144: the collection root
      // is the user id itself (OIDC sub, or CALDAV_USERNAME in env mode), never a display name.
      if (!process.env.DISABLE_INTERNAL_CALDAV) {
        const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
        const internalAcc = accounts.find(a => a.id === 'internal-caldav');
        if (!internalAcc) {
          accounts.unshift({
            id: 'internal-caldav',
            url: `${localCalDAVCUrl}/${userId}/`,
            username: userId,
            password: process.env.SYSTEM_SYNC_SECRET,
            displayName: 'Interner Kalender'
          });
        } else {
          internalAcc.username = userId;
          internalAcc.url = `${localCalDAVCUrl}/${userId}/`;
        }
      }
      
      setSessionAccounts(req, accounts);
      delete req.accountLoadError;
    } catch (e) {
      console.error('[db] Error loading accounts:', e.message);
      req.accountLoadError = e.message;
    }
  } else {
    setSessionAccounts(req, []);
  }
  next();
});

// ── OIDC Authentication Enforcer for the page ─────────────────────────────────
// Ahead of the static files (#224): served without a session, the SPA would only collect 401s.
app.get(['/', '/index.html'], (req, res, next) => {
  if ((process.env.AUTH_METHOD || 'env') === 'oidc' && !req.session.userId) {
    return res.redirect('/api/auth/login');
  }
  next();
});

const PUBLIC_DIR = path.join(__dirname, '../public');
app.get([...PUBLIC_BOOKING_FILES.keys()], (req, res, next) => {
  const file = PUBLIC_BOOKING_FILES.get(req.path);
  if (!file) return next();
  res.sendFile(file, { root: PUBLIC_DIR });
});

const serveStatic = express.static(PUBLIC_DIR);
app.use((req, res, next) => (isApiPath(req) ? next() : serveStatic(req, res, next)));

// ── Internal Hook Security Middleware ─────────────────────────────────────────
const requireInternal = createRequireInternalMiddleware(process.env);

// ── Mock CalDAV endpoint for testing ──────────────────────────────────────────
if (process.env.NODE_ENV === 'test' || process.env.ENABLE_MOCK_DAV === 'true') {
  const mockShares = [];
  const mockProperties = {};
  const mockResources = new Map();
  app.all(['/mock-dav*', '/.well-known/caldav', '/'], (req, res, next) => {
    if (req.path === '/' && req.method !== 'PROPFIND') {
      return next();
    }
    let rawBody = typeof req.body === 'string' ? req.body : '';
    
    const processMockDav = (xmlBody) => {
      const path = req.path;

      if (req.method === 'PUT') {
        const etag = '"etag-' + Math.random().toString(36).substring(2, 9) + '"';
        mockResources.set(path, { ics: xmlBody, etag });
        return res.status(201).set('ETag', etag).send('');
      }

      if (req.method === 'DELETE') {
        mockResources.delete(path);
        return res.status(204).send('');
      }

      if (req.method === 'GET') {
        if (mockResources.has(path)) {
          const item = mockResources.get(path);
          return res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', item.etag).send(item.ics);
        }
        if (req.query.export !== undefined || req.path.endsWith('.ics') || req.path.includes('/personal')) {
          return res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').send(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:test-event-1
SUMMARY:Test Event
DTSTART:20260710T100000Z
DTEND:20260710T110000Z
END:VEVENT
END:VCALENDAR`);
        }
      }

      if (req.method === 'PROPPATCH') {
        if (xmlBody.includes('remove') && xmlBody.includes('public-share-token')) {
          if (mockProperties[path]) delete mockProperties[path]['public-share-token'];
          if (mockProperties['/mock-dav/calendars/test/personal/']) delete mockProperties['/mock-dav/calendars/test/personal/']['public-share-token'];
        } else {
          const match = xmlBody.match(/<([^:>]+:)?public-share-token[^>]*>([^<]+)<\/([^:>]+:)?public-share-token>/i);
          if (match) {
            if (!mockProperties[path]) mockProperties[path] = {};
            mockProperties[path]['public-share-token'] = match[2].trim();
          }
        }
        return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${path}</d:href>
    <d:propstat>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      if (xmlBody.includes('cs:invite') || xmlBody.includes('o:invite')) {
        const userBlocks = mockShares.map(s => `
          <cs:user>
            <d:href>${s.href}</d:href>
            <cs:access><cs:${s.readWrite ? 'read-write' : 'read'}/></cs:access>
            <cs:invite-status>invite-accepted</cs:invite-status>
            <cs:common-name>${s.commonName || 'Test User'}</cs:common-name>
          </cs:user>
        `).join('');
        return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${path}</d:href>
    <d:propstat>
      <d:prop>
        <cs:invite>
          ${userBlocks}
        </cs:invite>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      if (xmlBody.includes('cs:share') || xmlBody.includes('o:share')) {
        if (xmlBody.includes('cs:remove') || xmlBody.includes('o:remove')) {
          const hrefMatch = xmlBody.match(/<d:href>([^<]+)<\/d:href>/i);
          if (hrefMatch) {
            const target = hrefMatch[1];
            const idx = mockShares.findIndex(s => s.href === target || s.href.includes(target) || target.includes(s.href));
            if (idx !== -1) mockShares.splice(idx, 1);
          }
        } else if (xmlBody.includes('cs:set') || xmlBody.includes('o:set')) {
          const hrefMatch = xmlBody.match(/<d:href>([^<]+)<\/d:href>/i);
          const readWrite = xmlBody.includes('read-write');
          if (hrefMatch) {
            const href = hrefMatch[1];
            const existing = mockShares.find(s => s.href === href);
            if (existing) {
              existing.readWrite = readWrite;
            } else {
              mockShares.push({ href, readWrite, commonName: 'Test User', status: 'ACCEPTED' });
            }
          }
        }
        return res.status(200).set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="utf-8"?><ok/>');
      }

      if (xmlBody.includes('principal-property-search') || path.includes('search')) {
        return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <d:response>
    <d:href>/mock-dav/principals/users/testuser</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Test User</d:displayname>
        <s:email-address>testuser@example.com</s:email-address>
        <d:principal-URL><d:href>/mock-dav/principals/users/testuser</d:href></d:principal-URL>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      if (req.method === 'REPORT') {
        if (xmlBody.includes('VTODO')) {
          const todoResponses = [];
          for (const [resPath, item] of mockResources.entries()) {
            if (item.ics.includes('BEGIN:VTODO')) {
              todoResponses.push(`
  <d:response>
    <d:href>${resPath}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${item.etag}</d:getetag>
        <c:calendar-data>${item.ics}</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
            }
          }
          return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  ${todoResponses.join('')}
</d:multistatus>`);
        }

        const veventResponses = [];
        for (const [resPath, item] of mockResources.entries()) {
          if (item.ics.includes('BEGIN:VEVENT')) {
            veventResponses.push(`
  <d:response>
    <d:href>${resPath}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${item.etag}</d:getetag>
        <c:calendar-data>${item.ics}</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
          }
        }
        if (veventResponses.length > 0) {
          return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  ${veventResponses.join('')}
</d:multistatus>`);
        }

        return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/mock-dav/calendars/test/personal/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"12345"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//EN
BEGIN:VEVENT
UID:test-event-1
SUMMARY:Test Event
DTSTART:20260710T100000Z
DTEND:20260710T110000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      const publicToken = mockProperties[path]?.['public-share-token'] || mockProperties['/mock-dav/calendars/test/personal/']?.['public-share-token'];
      const customPropsXml = publicToken ? `<public-share-token xmlns="http://freeshard.de/ns/">${publicToken}</public-share-token>` : '';

      if (req.headers['depth'] === '1' || (xmlBody.includes('displayname') && !xmlBody.includes('calendar-home-set'))) {
        return res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/mock-dav/calendars/test/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Persönlich</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <cs:getctag>1</cs:getctag>
        ${customPropsXml}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
      }

      // Default discovery response
      res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/mock-dav/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/mock-dav/principal/test/</d:href></d:current-user-principal>
        <c:calendar-home-set><d:href>/mock-dav/</d:href></c:calendar-home-set>
        ${customPropsXml}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
    };

    if (req.body && Object.keys(req.body).length > 0 && typeof req.body !== 'string') {
      rawBody = JSON.stringify(req.body);
      processMockDav(rawBody);
    } else {
      req.on('data', chunk => { rawBody += chunk.toString(); });
      req.on('end', () => { processMockDav(rawBody); });
    }
  });
}

// ── CSRF guard (#340) ─────────────────────────────────────────────────────────
// Every state-changing request below must come from the app's own origin.
app.use(csrfGuard);

// ── Auth guard for API routes ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId || !req.session.accounts || req.session.accounts.length === 0) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}
function requireSessionIdentity(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// ── Static files ──────────────────────────────────────────────────────────────
// Mounted after the session middleware, which skips every non-API path except the page (#172).

// ── Webhook route (Only accessible internally / local connection) ──────────────
app.post('/internal/webhooks/user-deleted', requireInternal, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    await Db.deleteUser(user_id);
    console.log(`[webhook] Cleaned up all user data for deleted user: ${user_id}`);
    res.json({ message: `Successfully deleted user ${user_id}` });
  } catch (err) {
    return sendError(res, err, `[webhook] Error deleting accounts for user ${user_id}:`);
  }
});

app.post('/internal/db/quiesce', requireInternal, async (req, res) => {
  try {
    const mode = req.body?.mode || 'TRUNCATE';
    const result = await Db.quiesceDatabase(mode);
    console.log(`[internal] Database WAL quiesce executed (mode=${mode}):`, result);
    res.json({ success: true, message: 'Database WAL quiesced', details: result });
  } catch (err) {
    return sendError(res, err, '[internal] Error quiescing database WAL:');
  }
});

// ── Healthcheck Endpoints ──────────────────────────────────────────────────
// Issue #270: the container healthcheck runs this. It is healthy only while the app can reach its
// storage: the database file and the internal CalDAV backend, which is asked for its root
// collection with the system credentials, as the app's own CalDAV requests are.
const HEALTH_CALDAV_TIMEOUT_MS = 3000;

async function checkInternalCalDAV() {
  const url = `${(process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232').replace(/\/+$/, '')}/`;
  const auth = Buffer.from(`healthcheck:${process.env.SYSTEM_SYNC_SECRET}`).toString('base64');
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: `Basic ${auth}`, Depth: '0', 'Accept-Encoding': 'identity' },
    dispatcher: dispatcherFor(url),
    redirect: 'manual',
    signal: AbortSignal.timeout(HEALTH_CALDAV_TIMEOUT_MS),
  });
  await res.arrayBuffer();
  if (res.status !== 207) throw new Error(`PROPFIND ${url} answered ${res.status}`);
}

const healthHandler = async (req, res) => {
  const checks = { database: Db.checkHealth() };
  if (!process.env.DISABLE_INTERNAL_CALDAV) checks.caldav = checkInternalCalDAV();
  const results = await Promise.allSettled(Object.values(checks));
  const body = { status: 'ok' };
  Object.keys(checks).forEach((name, i) => {
    if (results[i].status === 'fulfilled') {
      body[name] = 'connected';
      return;
    }
    const err = results[i].reason;
    console.error(`[health] ${name} check failed:`, err?.message, err?.cause?.message || '');
    body[name] = 'unavailable';
    body.status = 'error';
  });
  res.status(body.status === 'ok' ? 200 : 503).json(body);
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use('/api/auth',              createRateLimiter(AUTH_RATE_LIMIT), authRouter);
app.use('/api/public',            createRateLimiter(PUBLIC_RATE_LIMIT));
app.use('/api/public/calendars', publicRouter);
app.use('/api/accounts',          requireSessionIdentity, accountsRouter);
app.use('/api/calendars',         requireAuth, calendarsRouter);
app.use('/api/events',            requireAuth, eventsRouter);
app.use('/api/tasks',             requireAuth, tasksRouter);
// #97: with COOKIE_SAME_SITE=strict Microsoft's cross-site redirect carries no session cookie; this page forwards it same-site.
app.get('/api/msgraph/callback',  createRateLimiter(AUTH_RATE_LIMIT), msgraphRouter.forwardCallback);
app.use('/api/msgraph',           requireAuth, msgraphRouter);
app.use('/api/resources',         requireAuth, resourcesRouter);
app.use('/api/delegates',         requireAuth, delegatesRouter);
app.use('/api/working-hours',     requireAuth, workingHoursRouter);
app.use('/api/attachments',       requireAuth, attachmentsRouter);
app.use('/api/quick-add',         requireAuth, quickAddRouter);
app.use('/api/freebusy',          requireAuth, freebusyRouter);
app.use('/api/notifications',     notificationsRouter);
app.use('/api/webcal',            webcalRouter);
app.use('/api',                   availabilityRouter);

// ── Unmatched API 404 Handler ────────────────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  // Shapes like //api/x or /./api/x miss the '/api' mount above but are still API paths.
  if (isApiPath(req)) return res.status(404).json({ error: 'Not Found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.originalUrl, err.message, err.stack);
  if (res.headersSent) {
    return next(err);
  }
  // Client errors raised by middleware (body-parser: malformed JSON, oversized body).
  if (err.expose && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const message = err.status === 413 ? 'Die Anfrage ist zu groß.' : 'Die Anfrage ist ungültig.';
    return res.status(err.status).json({ error: message });
  }
  const { status, message } = describeError(err);
  res.status(status).json({ error: message });
});

const http = require('http');
const https = require('https');

let server;
const keyPath = process.env.SSL_KEY_PATH === '' ? '' : (process.env.SSL_KEY_PATH || path.join(__dirname, '../ssl/key.pem'));
const certPath = process.env.SSL_CERT_PATH === '' ? '' : (process.env.SSL_CERT_PATH || path.join(__dirname, '../ssl/cert.pem'));

// Issue #255: only `node server/index.js` binds a port. Importing this module (tests, tooling)
// yields the app and the unbound server; whoever imports it calls server.listen() itself.
const runAsMain = require.main === module;

let scheme = 'http';
if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  // An unreadable certificate is fatal; it never downgrades the server to plain HTTP.
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
  scheme = 'https';
} else {
  server = http.createServer(app);
}

function listen() {
  server.listen(PORT, () => {
    console.log(`🗓  FreeShard WebCalendar running on ${scheme}://localhost:${PORT}`);
    if (process.env.CALDAVURL) {
      console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
    }
  });
}

// Issue #333 / #343: the server process binds its port only after the schema migrations have run
// and the encryption key is proven to belong to the database (Db.ready); if either fails, it exits.
// An imported server may be bound earlier, but the Db.ready middleware above holds every request.
// The webcal worker reads migrated columns, so it never starts before Db.ready.
Db.ready.then(() => {
  if (!runAsMain) return;
  listen();
  module.exports.webcalWorker = startWebcalSyncWorker();
  module.exports.dbBackupWorker = startDbBackupWorker();
}).catch((err) => {
  console.error(`[startup] ${err.message}`);
  process.exit(1);
});

module.exports = { app, server, webcalWorker: null, validateSystemSyncSecret, validateSecurityConfig };


