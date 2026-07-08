'use strict';
require('dotenv').config();

// Prevent single async error from killing the process (Express 4 limitation)
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

const express = require('express');
const session = require('express-session');
const path = require('path');

const accountsRouter = require('./routes/accounts');
const { protectedRouter: calendarsRouter, publicRouter } = require('./routes/calendars');
const eventsRouter = require('./routes/events');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'freeshard-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// ── Auto-configure account from .env if present and session is empty ──────────
app.use((req, res, next) => {
  if (
    process.env.CALDAVURL &&
    process.env.CALDAV_USERNAME &&
    process.env.CALDAV_PASSWORD &&
    (!req.session.accounts || req.session.accounts.length === 0)
  ) {
    req.session.accounts = [{
      id: 'env-default',
      url: process.env.CALDAVURL,
      username: process.env.CALDAV_USERNAME,
      password: process.env.CALDAV_PASSWORD,
      displayName: process.env.ACCOUNT_DISPLAY_NAME || process.env.CALDAV_USERNAME
    }];
  }
  next();
});

// ── Auth guard for API routes ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.accounts || req.session.accounts.length === 0) {
    return res.status(401).json({ error: 'No accounts configured' });
  }
  next();
}

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/public/calendars', publicRouter);
app.use('/api/accounts',          accountsRouter);
app.use('/api/calendars',         requireAuth, calendarsRouter);
app.use('/api/events',            requireAuth, eventsRouter);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🗓  FreeShard WebCalendar running on http://localhost:${PORT}`);
  if (process.env.CALDAVURL) {
    console.log(`   Auto-configured CalDAV: ${process.env.CALDAVURL}`);
  }
});
