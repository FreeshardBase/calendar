'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getClientForAccount } = require('../caldav/helper');
const { parseCalendarList } = require('../caldav/parser');
const Db = require('../db');

function slugify(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Load/Generate Secret Key for Link Encryption
let secretKey;
const keyPath = process.env.DATABASE_PATH
  ? path.join(path.dirname(process.env.DATABASE_PATH), '.share_key')
  : path.join(__dirname, '../../.share_key');
if (process.env.SHARE_SECRET_KEY) {
  secretKey = crypto.createHash('sha256').update(process.env.SHARE_SECRET_KEY).digest();
} else {
  try {
    if (fs.existsSync(keyPath)) {
      secretKey = fs.readFileSync(keyPath);
    } else {
      secretKey = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, secretKey);
    }
  } catch (keyErr) {
    console.error('[keyPath Error]', keyErr.message);
    // Fallback to in-memory key to prevent crash (invalidates links on restart but stays online)
    secretKey = crypto.randomBytes(32);
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
    const Db = require('../db');
    let payload = null;
    let isDbShare = false;

    // 1. Try DB-based share lookup
    try {
      const shareRecord = await new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3');
        const path = require('path');
        const dbPath = path.join(__dirname, '../../webcalendar.db');
        const dbCon = new sqlite3.Database(dbPath);
        dbCon.get('SELECT * FROM calendar_shares WHERE token = ?', [req.params.token], (err, row) => {
          dbCon.close();
          if (err) return reject(err);
          resolve(row);
        });
      });

      if (shareRecord) {
        const calendarId = shareRecord.calendar_id;
        const sepIdx = calendarId.indexOf('::');
        if (sepIdx !== -1) {
          const accountId = calendarId.substring(0, sepIdx);
          const calendarUrl = calendarId.substring(sepIdx + 2);
          const account = await Db.getAccountById(accountId);
          if (account) {
            payload = {
              id: account.id,
              url: calendarUrl,
              username: account.username,
              password: account.password,
              authType: account.authType
            };
            isDbShare = true;
          }
        }
      }
    } catch (dbErr) {
      console.error('[share lookup error]', dbErr.message);
    }

    // 2. Fallback to token decryption
    if (!payload) {
      payload = decryptToken(req.params.token);
    }

    if (!payload) {
      return res.status(404).send('Calendar share not found or token invalid.');
    }

    const client = await getClientForAccount({
      id: payload.id,
      url: payload.url,
      username: payload.username,
      password: payload.password,
      authType: payload.authType
    });

    // Verify token matches the custom property on the CalDAV calendar (only for legacy encrypted shares)
    if (!isDbShare) {
      const activeTokenId = await client.getCustomProperty(payload.url, 'http://freeshard.de/ns/', 'public-share-token');
      if (!activeTokenId || activeTokenId !== payload.publicShareId) {
        return res.status(404).send('This public calendar share has been disabled or regenerated.');
      }
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
  const googleSlugs = new Set();

  await Promise.allSettled(
    accounts.map(async (account) => {
      const client = await getClientForAccount(account);

      const xml = await client.getCalendars();
      let calendars = parseCalendarList(xml, account.id, account.url, account.username);
      
      // Auto-create default calendar for new users on internal-caldav
      if (account.id === 'internal-caldav' && calendars.length === 0) {
        console.log(`[calendars] Creating default calendar 'personal' for user: ${account.username}`);
        try {
          const defaultCalUrl = account.url.replace(/\/+$/, '') + '/personal/';
          await client.mkcalendar(defaultCalUrl, 'Persönlich', '#7c3aed');
          const newXml = await client.getCalendars();
          calendars = parseCalendarList(newXml, account.id, account.url, account.username);
        } catch (createErr) {
          console.error('[calendars] Failed to create default calendar:', createErr.message);
        }
      }
      
      if (account.authType === 'oauth2') {
        for (const cal of calendars) {
          googleSlugs.add(slugify(cal.name));
        }
      } else {
        allCalendars.push(...calendars);
      }
    })
  ).then(results => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push({ accountId: accounts[i].id, error: r.reason.message });
        console.error(`[calendars] Account ${accounts[i].id}:`, r.reason.message);
      }
    });
  });

  // Fetch shared calendars for the logged-in user
  const userId = req.session.userId;
  const internalAccount = accounts.find(a => a.id === 'internal-caldav');
  if (userId && internalAccount) {
    try {
      const sharedCals = await Db.getSharedCalendarsForUser(userId);
      if (sharedCals.length > 0) {
        const client = await getClientForAccount(internalAccount);
        await Promise.allSettled(
          sharedCals.map(async (share) => {
            try {
              const parts = share.calendar_id.split('::');
              const calendarHref = parts[1];
              
              const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://caldav-server:5232';
              const calendarUrl = localCalDAVCUrl.replace(/\/+$/, '') + calendarHref;
              
              const xmlRes = await client._request('PROPFIND', calendarUrl, {
                body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <c:calendar-color/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
                headers: { Depth: '0' }
              });
              
              if (xmlRes.ok || xmlRes.status === 207) {
                const xml = await xmlRes.text();
                const parsed = parseCalendarList(xml, 'internal-caldav', calendarUrl, internalAccount.username);
                if (parsed.length > 0) {
                  const cal = parsed[0];
                  cal.id = share.calendar_id;
                  cal.readOnly = !share.read_write;
                  cal.isShared = true;
                  
                  const ownerUuid = calendarHref.split('/').filter(Boolean)[0];
                  cal.owner = await Db.getUsernameByUserId(ownerUuid);
                  
                  allCalendars.push(cal);
                }
              }
            } catch (shareErr) {
              console.error(`[calendars GET] Failed to load shared calendar ${share.calendar_id}:`, shareErr.message);
            }
          })
        );
      }
    } catch (dbErr) {
      console.error('[calendars GET] Failed to fetch shares from DB:', dbErr.message);
    }
  }

  // Post-process returned calendars to sanitize names and tag sources
  for (const cal of allCalendars) {
    const segments = cal.href.replace(/\/$/, '').split('/');
    const collectionName = segments[segments.length - 1];

    const isGoogle = googleSlugs.has(collectionName) ||
                     collectionName.startsWith('google-') ||
                     collectionName.startsWith('feiertage-') ||
                     collectionName.startsWith('family-') ||
                     collectionName === 'family' ||
                     collectionName === 'feiertage-in-deutschland';

    cal.source = isGoogle ? 'google' : 'local';

    // Strip UUID prefix if present in the display name
    if (cal.name.includes('/')) {
      const parts = cal.name.split('/');
      cal.name = parts[parts.length - 1];
    }
    // Strip trailing "(Google)" if present
    cal.name = cal.name.replace(/ \(Google\)$/, '');
  }

  console.log('[calendars route] Returning calendars:', allCalendars.map(c => `${c.accountId}::${c.name} (${c.source})`));

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

    const client = await getClientForAccount(account);

    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const calendarUrl = account.url.replace(/\/+$/, '') + '/' + slug + '/';

    await client.mkcalendar(calendarUrl, name, color || '#7c3aed');

    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
    }

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
async function resolveCalendar(req, calendarId) {
  const sep = calendarId.indexOf('::');
  if (sep === -1) return {};
  const accountId    = calendarId.slice(0, sep);
  const calendarHref = calendarId.slice(sep + 2);
  const account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) return {};

  const client = await getClientForAccount(account);
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

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
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

    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
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
    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const delRes = await client._request('DELETE', calendarUrl);
    if (!delRes.ok && delRes.status !== 204) {
      const text = await delRes.text().catch(() => '');
      throw new Error(`DELETE ${delRes.status}: ${text.slice(0, 200) || delRes.statusText}`);
    }

    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
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
    console.log('[search-users] Query:', q, 'AccountId:', accountId);
    if (!q) return res.status(400).json({ error: 'Search query q is required' });

    const accounts = req.session.accounts || [];
    const account = accountId ? accounts.find(a => a.id === accountId) : accounts[0];
    if (!account) {
      console.warn('[search-users] Account not found');
      return res.status(404).json({ error: 'Account not found' });
    }

    if (account.id === 'internal-caldav') {
      const users = await Db.searchUsers(q);
      console.log('[search-users] Local database results:', users);
      return res.json(users);
    }

    const client = await getClientForAccount(account);

    const users = await client.searchUsers(q);
    console.log('[search-users] CalDAV results found:', users);
    res.json(users);
  } catch (err) {
    console.error('[search-users ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendars/:id/shares — list invitees / shares of a calendar
router.get('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { accountId } = await resolveCalendar(req, calendarId);

    if (accountId === 'internal-caldav') {
      const shares = await Db.getUserShares(calendarId);
      return res.json({ shares });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
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

    const { accountId } = await resolveCalendar(req, calendarId);

    if (accountId === 'internal-caldav') {
      const shareeUserId = sharee.replace(/\//g, '');
      await Db.addUserShare(calendarId, shareeUserId, !!readWrite);
      return res.json({ message: 'Share invite sent.' });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
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

    const { accountId } = await resolveCalendar(req, calendarId);

    if (accountId === 'internal-caldav') {
      const shareeUserId = sharee.replace(/\//g, '');
      await Db.removeUserShare(calendarId, shareeUserId);
      return res.json({ message: 'Share removed.' });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
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
    const { account, client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const activeTokenId = await client.getCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token');
    if (!activeTokenId) {
      return res.json({ enabled: false });
    }

    const token = encryptToken({
      url: calendarUrl,
      username: account.username,
      password: account.password,
      publicShareId: activeTokenId,
      id: account.id,
      authType: account.authType
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
    const { account, client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const publicShareId = crypto.randomUUID();
    await client.setCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token', publicShareId);

    const token = encryptToken({
      url: calendarUrl,
      username: account.username,
      password: account.password,
      publicShareId,
      id: account.id,
      authType: account.authType
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
    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.setCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token', null);
    res.json({ enabled: false, message: 'Public share link disabled.' });
  } catch (err) {
    console.error('[public-link DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Multiple Public Shares (Token-based) API ────────────────────────────────

// GET /api/calendars/:id/shares-public — list all public share tokens
router.get('/:id/shares-public', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const shares = await Db.getCalendarShares(calendarId);
    res.json(shares.map(s => ({
      token: s.token,
      label: s.label,
      createdAt: s.createdAt,
      url: `${req.protocol}://${req.get('host')}/api/public/calendars/share/${s.token}.ics`
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendars/:id/shares-public — create a new public share token
router.post('/:id/shares-public', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Bezeichnung ist erforderlich.' });
    }
    const share = await Db.addCalendarShare(calendarId, label.trim());
    res.status(201).json({
      token: share.token,
      label: share.label,
      createdAt: share.createdAt,
      url: `${req.protocol}://${req.get('host')}/api/public/calendars/share/${share.token}.ics`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendars/:id/shares-public/:token — revoke/delete public share token
router.delete('/:id/shares-public/:token', async (req, res) => {
  try {
    await Db.deleteCalendarShare(req.params.token);
    res.json({ message: 'Freigabe-Link widerrufen.' });
  } catch (err) {
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
