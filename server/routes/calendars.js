'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CalDAVClient = require('../caldav/client');
const { parseCalendarList } = require('../caldav/parser');

// Load/Generate Secret Key for Link Encryption
let secretKey;
const keyPath = path.join(__dirname, '../../.share_key');
if (process.env.SHARE_SECRET_KEY) {
  secretKey = crypto.createHash('sha256').update(process.env.SHARE_SECRET_KEY).digest();
} else {
  if (fs.existsSync(keyPath)) {
    secretKey = fs.readFileSync(keyPath);
  } else {
    secretKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, secretKey);
  }
}

function encryptToken(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', secretKey, iv);
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptToken(token) {
  try {
    const parts = token.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', secretKey, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

// ── Public Router ─────────────────────────────────────────────────────────────
const publicRouter = express.Router();

publicRouter.get('/share/:token.ics', async (req, res) => {
  try {
    const payload = decryptToken(req.params.token);
    if (!payload) {
      return res.status(404).send('Calendar share not found or token invalid.');
    }

    const client = new CalDAVClient({
      url: payload.url,
      username: payload.username,
      password: payload.password
    });

    // Verify token matches the custom property on the CalDAV calendar
    const activeTokenId = await client.getCustomProperty(payload.url, 'http://freeshard.de/ns/', 'public-share-token');
    if (!activeTokenId || activeTokenId !== payload.publicShareId) {
      return res.status(404).send('This public calendar share has been disabled or regenerated.');
    }

    const exportUrl = payload.url.endsWith('/') ? (payload.url + '?export') : (payload.url + '/?export');
    const davRes = await client._request('GET', exportUrl);

    if (davRes.ok) {
      const icsData = await davRes.text();
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="calendar.ics"`);
      return res.send(icsData);
    }

    // Fallback: fetch events and serialize to ICS format
    const now = new Date();
    const start = new Date(now.getFullYear() - 1, 0, 1).toISOString();
    const end = new Date(now.getFullYear() + 5, 11, 31).toISOString();

    const events = await client.getEvents(payload.url, start, end);
    const { serializeEvent } = require('../caldav/parser');

    let ics = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//FreeShard WebCalendar//NONSGML v1.0//EN\r
CALSCALE:GREGORIAN\r\n`;

    for (const ev of events) {
      const evIcs = serializeEvent(ev);
      const cleanIcs = evIcs
        .replace(/^BEGIN:VCALENDAR\r?\n?/i, '')
        .replace(/END:VCALENDAR\r?\n?$/i, '');
      ics += cleanIcs;
    }

    ics += 'END:VCALENDAR\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="calendar.ics"`);
    res.send(ics);
  } catch (err) {
    console.error('[Public Share Export Error]', err.message);
    res.status(500).send('Error generating calendar export: ' + err.message);
  }
});

// GET /api/calendars — fetch all calendars from all accounts
router.get('/', async (req, res) => {
  const accounts = req.session.accounts || [];
  const allCalendars = [];
  const errors = [];

  await Promise.allSettled(
    accounts.map(async (account) => {
      const client = new CalDAVClient({
        url:      account.url,
        username: account.username,
        password: account.password
      });

      const xml = await client.getCalendars();
      const calendars = parseCalendarList(xml, account.id, account.url);
      allCalendars.push(...calendars);
    })
  ).then(results => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push({ accountId: accounts[i].id, error: r.reason.message });
        console.error(`[calendars] Account ${accounts[i].id}:`, r.reason.message);
      }
    });
  });

  res.json({ calendars: allCalendars, errors });
});

// POST /api/calendars — create a new calendar collection
router.post('/', async (req, res) => {
  try {
    const { accountId, name, color } = req.body;

    if (!accountId || !name) {
      return res.status(400).json({ error: 'accountId and name are required' });
    }

    const account = (req.session.accounts || []).find(a => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = new CalDAVClient({
      url:      account.url,
      username: account.username,
      password: account.password
    });

    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const calendarUrl = account.url.replace(/\/+$/, '') + '/' + slug + '/';

    await client.mkcalendar(calendarUrl, name, color || '#7c3aed');

    res.status(201).json({
      message: 'Calendar created',
      url: calendarUrl,
      id: `${accountId}::${new URL(calendarUrl).pathname}`
    });
  } catch (err) {
    console.error('[calendars POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: resolve account + calendar URL from calendarId ──────────────────
function resolveCalendar(req, calendarId) {
  const sep = calendarId.indexOf('::');
  if (sep === -1) return {};
  const accountId    = calendarId.slice(0, sep);
  const calendarHref = calendarId.slice(sep + 2);
  const account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) return {};

  const client = new CalDAVClient({
    url: account.url, username: account.username, password: account.password
  });
  const calendarUrl = calendarHref.startsWith('http')
    ? calendarHref
    : new URL(calendarHref, account.url).href;

  return { account, client, calendarUrl };
}

// PATCH /api/calendars/:id — rename and/or recolor a calendar
router.patch('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { name, color } = req.body;

    if (!name && !color) {
      return res.status(400).json({ error: 'At least name or color is required' });
    }

    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const props = [];
    if (name)  props.push(`<d:displayname>${escXML(name)}</d:displayname>`);
    if (color) props.push(`<a:calendar-color>${escXML(color)}</a:calendar-color>`);

    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">
  <d:set>
    <d:prop>
      ${props.join('\n      ')}
    </d:prop>
  </d:set>
</d:propertyupdate>`;

    const patchRes = await client._request('PROPPATCH', calendarUrl, { body });
    if (!patchRes.ok && patchRes.status !== 207) {
      const text = await patchRes.text().catch(() => '');
      throw new Error(`PROPPATCH ${patchRes.status}: ${text.slice(0, 200) || patchRes.statusText}`);
    }

    res.json({ message: 'Calendar updated', calendarId, name, color });
  } catch (err) {
    console.error('[calendars PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendars/:id — delete a calendar collection and all its events
router.delete('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const delRes = await client._request('DELETE', calendarUrl);
    if (!delRes.ok && delRes.status !== 204) {
      const text = await delRes.text().catch(() => '');
      throw new Error(`DELETE ${delRes.status}: ${text.slice(0, 200) || delRes.statusText}`);
    }

    res.json({ message: 'Calendar deleted', calendarId });
  } catch (err) {
    console.error('[calendars DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendars/search-users — search principals for sharing
router.get('/search-users', async (req, res) => {
  try {
    const { q, accountId } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query q is required' });

    const accounts = req.session.accounts || [];
    const account = accountId ? accounts.find(a => a.id === accountId) : accounts[0];
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = new CalDAVClient({
      url: account.url,
      username: account.username,
      password: account.password
    });

    const users = await client.searchUsers(q);
    res.json(users);
  } catch (err) {
    console.error('[search-users]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendars/:id/shares — list invitees / shares of a calendar
router.get('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const shares = await client.getCalendarShares(calendarUrl);
    res.json({ shares });
  } catch (err) {
    console.error('[shares GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendars/:id/shares — add/update calendar share invitee
router.post('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { sharee, readWrite } = req.body;
    if (!sharee) return res.status(400).json({ error: 'sharee is required' });

    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.updateCalendarShares(calendarUrl, { href: sharee, readWrite: !!readWrite });
    res.json({ message: 'Share invite sent.' });
  } catch (err) {
    console.error('[shares POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendars/:id/shares — remove a share invitee
router.delete('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { sharee } = req.body;
    if (!sharee) return res.status(400).json({ error: 'sharee parameter is required in request body' });

    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.updateCalendarShares(calendarUrl, { href: sharee, remove: true });
    res.json({ message: 'Share removed.' });
  } catch (err) {
    console.error('[shares DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendars/:id/public-link — get public webcal status
router.get('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { account, client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const activeTokenId = await client.getCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token');
    if (!activeTokenId) {
      return res.json({ enabled: false });
    }

    const token = encryptToken({
      url: calendarUrl,
      username: account.username,
      password: account.password,
      publicShareId: activeTokenId
    });

    res.json({
      enabled: true,
      url: `${req.protocol}://${req.get('host')}/api/public/calendars/share/${token}.ics`
    });
  } catch (err) {
    console.error('[public-link GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendars/:id/public-link — enable/generate public link
router.post('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { account, client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const publicShareId = crypto.randomUUID();
    await client.setCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token', publicShareId);

    const token = encryptToken({
      url: calendarUrl,
      username: account.username,
      password: account.password,
      publicShareId
    });

    res.json({
      enabled: true,
      url: `${req.protocol}://${req.get('host')}/api/public/calendars/share/${token}.ics`
    });
  } catch (err) {
    console.error('[public-link POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendars/:id/public-link — disable public link
router.delete('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.setCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token', null);
    res.json({ enabled: false, message: 'Public share link disabled.' });
  } catch (err) {
    console.error('[public-link DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function escXML(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  protectedRouter: router,
  publicRouter: publicRouter
};
