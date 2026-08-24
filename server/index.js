'use strict';
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
const Db = require('./db');
const { getTrustProxySetting, getSessionConfig } = require('./utils/sessionConfig');

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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', getTrustProxySetting());

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session(getSessionConfig()));

// ── Middleware to load accounts from SQLite database into req.session.accounts ──
app.use(async (req, res, next) => {
  const authMethod = process.env.NODE_ENV === 'test' ? 'env' : (process.env.AUTH_METHOD || 'env');
  let userId = req.session.userId;
  if (req.headers['x-test-user-id'] === 'unauthenticated' || req.headers['x-test-user-id'] === 'none') {
    delete req.session.userId;
    userId = null;
  } else if (req.headers['x-test-user-id']) {
    userId = req.headers['x-test-user-id'];
    req.session.userId = userId;
  } else if (!userId && authMethod === 'env') {
    userId = process.env.CALDAV_USERNAME || 'test';
    req.session.userId = userId;
  }

  if (userId) {
    try {
      await Db.upsertUser(userId, userId);
      if (process.env.NODE_ENV === 'test') {
        await Db.upsertUser('testuser-id', 'testuser@example.com');
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
      if (!process.env.DISABLE_INTERNAL_CALDAV && !accounts.some(a => a.id === 'internal-caldav')) {
        const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
        accounts.unshift({
          id: 'internal-caldav',
          url: `${localCalDAVCUrl}/${userId}/`,
          username: userId,
          password: process.env.SYSTEM_SYNC_SECRET || 'super-secret-bypass',
          displayName: 'Interner Kalender'
        });
      }
      
      req.session.accounts = accounts;
    } catch (e) {
      console.error('[db] Error loading accounts:', e.message);
      req.session.accounts = [];
    }
  } else {
    req.session.accounts = [];
  }
  next();
});

// ── Internal Hook Security Middleware ─────────────────────────────────────────
function requireInternal(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();
  const ip = req.ip || req.connection.remoteAddress;
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const secret = req.headers['x-freeshard-secret'];
  const expectedSecret = process.env.INTERNAL_WEBHOOK_SECRET;

  if (isLocal || (expectedSecret && secret === expectedSecret)) {
    return next();
  }
  return res.status(403).json({ error: 'Access denied: Internal only' });
}

// ── Mock CalDAV endpoint for testing ──────────────────────────────────────────
app.all('/mock-dav*', (req, res) => {
  res.status(207).set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/mock-dav/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal><d:href>/mock-dav/principal/test/</d:href></d:current-user-principal>
        <c:calendar-home-set><d:href>/mock-dav/calendars/test/</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
});

// ── Auth guard for API routes ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId || !req.session.accounts || req.session.accounts.length === 0) {
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
app.use(express.static(path.join(__dirname, '../public')));

// ── Webhook route (Only accessible internally / local connection) ──────────────
app.post('/internal/webhooks/user-deleted', requireInternal, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    await Db.deleteUserAccounts(user_id);
    console.log(`[webhook] Cleaned up accounts for deleted user: ${user_id}`);
    res.json({ message: `Successfully deleted accounts for user ${user_id}` });
  } catch (err) {
    console.error(`[webhook] Error deleting accounts for user ${user_id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use('/api/auth',              authRouter);
app.use('/api/public/calendars', publicRouter);
app.use('/api/accounts',          accountsRouter);
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
app.use('/api',                   availabilityRouter);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const http = require('http');
const https = require('https');

let server;
const keyPath = process.env.SSL_KEY_PATH === '' ? '' : (process.env.SSL_KEY_PATH || path.join(__dirname, '../ssl/key.pem'));
const certPath = process.env.SSL_CERT_PATH === '' ? '' : (process.env.SSL_CERT_PATH || path.join(__dirname, '../ssl/cert.pem'));

if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    server = https.createServer(options, app);
    server.listen(PORT, () => {
      console.log(`🗓  FreeShard WebCalendar running securely on https://localhost:${PORT}`);
      if (process.env.CALDAVURL) {
        console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
      }
    });
  } catch (sslErr) {
    console.error('[SSL Startup Error]', sslErr.message);
    server = http.createServer(app);
    server.listen(PORT, () => {
      console.log(`🗓  FreeShard WebCalendar running on http://localhost:${PORT} (fallback)`);
    });
  }
} else {
  server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`🗓  FreeShard WebCalendar running on http://localhost:${PORT}`);
    if (process.env.CALDAVURL) {
      console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
    }
  });
}

module.exports = { app, server };

