'use strict';
require('dotenv').config();
const { sendError, describeError } = require('./utils/errorSanitizer');
// Issue #57 fix: NODE_TLS_REJECT_UNAUTHORIZED is no longer set process-wide.
// Per-request TLS bypass for the internal self-signed Radicale server is handled
// exclusively in server/utils/tlsDispatcher.js via a scoped undici Agent.
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));
} catch {}

// Prevent single async error from killing the process (Express 4 limitation)
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

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

  if ((isProd || isStaging) && isWeak && env.ALLOW_INSECURE_SYSTEM_SYNC_SECRET !== 'true' && env.E2E_TEST !== 'true') {
    const msg = 'SYSTEM_SYNC_SECRET must be explicitly configured with a secure value in production environment.';
    if (env.EXIT_ON_INVALID_SECRETS === 'true' || require.main === module) {
      console.error(msg);
      process.exit(1);
    }
    throw new Error(msg);
  }
}

// Issue #82: Validate SYSTEM_SYNC_SECRET on server boot before any subsystems load
if (require.main === module || process.env.EXIT_ON_INVALID_SECRETS === 'true') {
  validateSystemSyncSecret(process.env);
}

const Db = require('./db');
const { getTrustProxySetting, getSessionConfig } = require('./utils/sessionConfig');
const { createRequireInternalMiddleware } = require('./utils/internalAuth');
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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', getTrustProxySetting());

// Issue #333: never run with an encryption key that does not belong to the database.
Db.ready.catch((err) => {
  console.error(`[startup] ${err.message}`);
  process.exit(1);
});

// ── Middleware ────────────────────────────────────────────────────────────────
// No request is served before the encryption key has been verified against the database.
app.use((req, res, next) => {
  Db.ready.then(() => next(), next);
});
app.use(compression());
app.use(securityHeaders);
app.use(session(getSessionConfig()));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Middleware to load accounts from SQLite database into req.session.accounts ──
app.use(async (req, res, next) => {
  const authMethod = process.env.AUTH_METHOD || 'env';
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true';
  let newUserId = req.session.userId;
  if (isTestEnv && (req.headers['x-test-user-id'] === 'unauthenticated' || req.headers['x-test-user-id'] === 'none')) {
    if (req.session.userId !== undefined) {
      delete req.session.userId;
    }
    delete req.session.userEmail;
    newUserId = null;
  } else if (isTestEnv && req.headers['x-test-user-id']) {
    newUserId = req.headers['x-test-user-id'];
    if (req.headers['x-test-username']) {
      req.session.username = req.headers['x-test-username'];
    }
    if (req.headers['x-test-email'] || req.headers['x-test-user-email']) {
      req.session.userEmail = (req.headers['x-test-email'] || req.headers['x-test-user-email']).trim().toLowerCase();
    } else if (req.headers['x-test-username'] && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.headers['x-test-username'].trim())) {
      req.session.userEmail = req.headers['x-test-username'].trim().toLowerCase();
    }
  } else if (authMethod === 'oidc' || process.env.HTTP_HEADER_AUTH === 'true') {
    const expectedSecret = process.env.HTTP_HEADER_AUTH_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
    const providedSecret = req.headers['x-freeshard-secret'] || req.headers['x-internal-secret'];

    if (expectedSecret && providedSecret === expectedSecret) {
      const headerUser = req.headers['x-forwarded-user'] || req.headers['x-user-id'] || req.headers['remote-user'] || req.headers['x-ptl-client-id'];
      if (headerUser) {
        newUserId = String(headerUser).trim();
      }
      const headerEmail = req.headers['x-forwarded-email'] || req.headers['remote-email'] || req.headers['x-user-email'];
      if (headerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(headerEmail).trim())) {
        req.session.userEmail = String(headerEmail).trim().toLowerCase();
      } else if (headerUser && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(headerUser).trim())) {
        req.session.userEmail = String(headerUser).trim().toLowerCase();
      }
    }
  } else if (!newUserId && authMethod === 'env' && (req.path === '/' || req.path === '/index.html' || req.path === '/api/auth/session' || process.env.E2E_TEST === 'true')) {
    newUserId = process.env.CALDAV_USERNAME || 'test';
    if (process.env.CALDAV_EMAIL) {
      req.session.userEmail = process.env.CALDAV_EMAIL.trim().toLowerCase();
    } else if (process.env.CALDAV_USERNAME && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.CALDAV_USERNAME.trim())) {
      req.session.userEmail = process.env.CALDAV_USERNAME.trim().toLowerCase();
    }
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
        if (process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') {
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

      // Inject the internal CalDAV account (Radicale) unless disabled
      const canonicalUsername = (await Db.getUsernameByUserId(userId)) || userId;
      if (!process.env.DISABLE_INTERNAL_CALDAV) {
        const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
        const internalAcc = accounts.find(a => a.id === 'internal-caldav');
        if (!internalAcc) {
          accounts.unshift({
            id: 'internal-caldav',
            url: `${localCalDAVCUrl}/${canonicalUsername}/`,
            username: canonicalUsername,
            password: process.env.SYSTEM_SYNC_SECRET,
            displayName: 'Interner Kalender'
          });
        } else {
          internalAcc.username = canonicalUsername;
          internalAcc.url = `${localCalDAVCUrl}/${canonicalUsername}/`;
        }
      }
      
      const accountsStr = JSON.stringify(accounts);
      if (!req.session.accounts || JSON.stringify(req.session.accounts) !== accountsStr) {
        req.session.accounts = accounts;
      }
      delete req.accountLoadError;
    } catch (e) {
      console.error('[db] Error loading accounts:', e.message);
      req.accountLoadError = e.message;
    }
  } else {
    if (req.session.accounts && req.session.accounts.length > 0) {
      req.session.accounts = [];
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

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

// ── OIDC Authentication Enforcer for Page Root ────────────────────────────────
app.get('/', (req, res, next) => {
  const authMethod = process.env.NODE_ENV === 'test' ? 'env' : (process.env.AUTH_METHOD || 'env');
  if (authMethod === 'oidc' && !req.session.userId) {
    return res.redirect('/api/auth/login');
  }
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
// Express static middleware is mounted above session middleware to avoid session overhead on static assets

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
const healthHandler = async (req, res) => {
  try {
    await Db.checkHealth();
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('[health] Database check failed:', err?.message);
    res.status(500).json({ status: 'error', error: 'Database query failed' });
  }
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use('/api/auth',              authRouter);
app.use('/api/public/calendars', publicRouter);
app.use('/api/accounts',          requireSessionIdentity, accountsRouter);
app.use('/api/calendars',         requireAuth, calendarsRouter);
app.use('/api/events',            requireAuth, eventsRouter);
app.use('/api/tasks',             requireAuth, tasksRouter);
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

const shouldListen = require.main === module || (process.env.NODE_ENV === 'test' && !process.env.PREVENT_AUTO_LISTEN);

if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    server = https.createServer(options, app);
    if (shouldListen) {
      server.listen(PORT, () => {
        console.log(`🗓  FreeShard WebCalendar running securely on https://localhost:${PORT}`);
        if (process.env.CALDAVURL) {
          console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
        }
      });
    }
  } catch (sslErr) {
    console.error('[SSL Startup Error]', sslErr.message);
    server = http.createServer(app);
    if (shouldListen) {
      server.listen(PORT, () => {
        console.log(`🗓  FreeShard WebCalendar running on http://localhost:${PORT} (fallback)`);
      });
    }
  }
} else {
  server = http.createServer(app);
  if (shouldListen) {
    server.listen(PORT, () => {
      console.log(`🗓  FreeShard WebCalendar running on http://localhost:${PORT}`);
      if (process.env.CALDAVURL) {
        console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
      }
    });
  }
}

let webcalWorker = null;
if (shouldListen) {
  webcalWorker = startWebcalSyncWorker();
}

module.exports = { app, server, webcalWorker, validateSystemSyncSecret };


