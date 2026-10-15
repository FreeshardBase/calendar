'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ICAL = require('ical.js');
const { getClientForAccount } = require('../caldav/helper');
const { parseCalendarList, parseSyncCollectionResponse, resolveUrl } = require('../caldav/parser');
const { detectICSConflicts, resolveICSImport } = require('../utils/icsConflictResolver');
const { detectTwoWayConflict, resolveTwoWayConflict } = require('../utils/twoWaySyncResolver');
const Db = require('../db');
const { checkCalendarAccess, queueSyncForCalendar } = require('../utils/calendarAuth');
const { ICS_CACHE_TTL_SECONDS, ICS_RATE_LIMIT_MAX, ICS_RATE_LIMIT_WINDOW_SECONDS } = require('../utils/icsPublicShareCache');
const { getPublicShareUrl } = require('../utils/baseUrl');
const { sendError, describeError, userError, MESSAGES } = require('../utils/errorSanitizer');
const { sanitizePublicIcs, isValidDetail, DEFAULT_DETAIL } = require('../utils/publicIcs');

const SHARE_NS = 'http://freeshard.de/ns/';

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
  // #343: an unreadable or unwritable key file is fatal; an in-memory key would silently
  // invalidate every public share link on the next restart.
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

const PUBLIC_SHARE_ERROR = 'Der freigegebene Kalender kann gerade nicht abgerufen werden. Bitte versuche es später erneut.';

publicRouter.get('/share/:token.ics', async (req, res) => {
  const token = req.params.token;
  try {
    // ── Rate-limit check (before any DB share lookup) ───────────────────────
    const hitCount = await Db.getIcsFetchCount(token, ICS_RATE_LIMIT_WINDOW_SECONDS);
    if (hitCount >= ICS_RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', String(ICS_RATE_LIMIT_WINDOW_SECONDS));
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' });
    }

    let payload = null;
    let isDbShare = false;
    let detail = DEFAULT_DETAIL;

    // 1. Try DB-based share lookup
    const shareRecord = await Db.getCalendarShareByToken(token);

    if (shareRecord) {
      const calendarId = shareRecord.calendar_id;
      const sepIdx = calendarId.indexOf('::');
      if (sepIdx !== -1) {
        const accountId = calendarId.substring(0, sepIdx);
        const calendarHref = calendarId.substring(sepIdx + 2);
        const account = await resolveShareAccount(accountId, calendarHref);
        if (account) {
          payload = {
            id: account.id,
            url: resolveUrl(account.url, calendarHref),
            username: account.username,
            password: account.password,
            authType: account.authType
          };
          isDbShare = true;
          detail = shareRecord.detail;
        }
      }
    }

    // 2. Fallback to token decryption
    if (!payload) {
      const decrypted = decryptToken(token);
      if (decrypted) {
        const account = await resolveShareAccount(decrypted.id, decrypted.url);
        if (account) {
          payload = {
            id: account.id,
            url: resolveUrl(account.url, decrypted.url),
            username: account.username,
            password: account.password,
            authType: account.authType,
            publicShareId: decrypted.publicShareId
          };
        }
      }
    }

    if (!payload) {
      await Db.deleteIcsCache(token);
      return res.status(404).json({ error: 'Kalenderfreigabe nicht gefunden oder Token ungültig.' });
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
      let activeTokenId = null;
      try {
        activeTokenId = await client.getCustomProperty(payload.url, 'http://freeshard.de/ns/', 'public-share-token');
      } catch (propErr) {
        console.warn('[share token check warning]', propErr);
        await Db.deleteIcsCache(token);
        return res.status(404).json({ error: 'Diese öffentliche Kalenderfreigabe ist nicht mehr gültig.' });
      }
      if (!activeTokenId || activeTokenId !== payload.publicShareId) {
        await Db.deleteIcsCache(token);
        return res.status(404).json({ error: 'Diese öffentliche Kalenderfreigabe wurde deaktiviert oder neu erstellt.' });
      }
      detail = (await client.getCustomProperty(payload.url, SHARE_NS, 'public-share-detail')) || DEFAULT_DETAIL;
    }

    // The cache holds the raw collection; the share's detail level is applied
    // on every response so a level change takes effect immediately (#341).

    // ── Cache-first serve (after authorization verification) ────────────────
    const cached = await Db.getIcsCache(token);
    if (cached) {
      await Db.recordIcsFetch(token);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
      res.setHeader('X-Cache', 'HIT');
      return res.send(sanitizePublicIcs(cached.body, detail));
    }

    const ics = await fetchCalendarICS(client, payload.url);
    const publicIcs = sanitizePublicIcs(ics, detail);

    // ── Populate cache + record fetch ───────────────────────────────────────
    await Db.upsertIcsCache(token, ics, ICS_CACHE_TTL_SECONDS);
    await Db.recordIcsFetch(token);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="calendar.ics"`);
    res.setHeader('X-Cache', 'MISS');
    res.send(publicIcs);
  } catch (err) {
    // The caller is an anonymous subscriber (#162): log the cause, but answer with
    // one fixed text and status so nothing about the owner's accounts, the upstream
    // server or its responses reaches them.
    console.error('[Public Share Export Error]', err?.stack || err);
    return res.status(500).json({ error: PUBLIC_SHARE_ERROR });
  }
});

/**
 * Fetch a whole calendar collection as one ICS document. Tries a collection
 * GET first (Radicale native, Nextcloud via ?export), falls back to a
 * calendar-query REPORT re-assembled from the raw event payloads.
 * Throws (status 502, German message; the cause is logged) when both fail —
 * an empty calendar would make subscribers delete every event (#341).
 */
async function fetchCalendarICS(client, calendarUrl) {
  const exportUrl = calendarUrl.endsWith('/') ? (calendarUrl + '?export') : (calendarUrl + '/?export');
  try {
    const davRes = await client._request('GET', exportUrl);
    if (davRes && davRes.ok) {
      return await davRes.text();
    }
  } catch (e) {
    console.warn('[fetchCalendarICS] GET export failed, attempting REPORT fallback:', e.message);
  }

  // Fallback: query events via REPORT and re-assemble a combined calendar
  try {
    const eventsXml = await client.getEvents(calendarUrl);
    const { parseEventDataList } = require('../caldav/parser');

    let ics = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//FreeShard WebCalendar//NONSGML v1.0//EN\r
CALSCALE:GREGORIAN\r\n`;

    for (const evIcs of parseEventDataList(eventsXml)) {
      // Keep only the components (VEVENT/VTIMEZONE) of each per-event calendar
      const components = evIcs.match(/BEGIN:(VEVENT|VTIMEZONE)[\s\S]*?END:\1/g) || [];
      for (const comp of components) {
        ics += comp.replace(/\r?\n/g, '\r\n') + '\r\n';
      }
    }

    ics += 'END:VCALENDAR\r\n';
    return ics;
  } catch (err) {
    console.error('[fetchCalendarICS fallback error]', err.message);
    throw userError(MESSAGES.UPSTREAM_DOWN, 502);
  }
}

/**
 * Resolve the owning account for a DB-based public share. The `internal-caldav`
 * and `env-default` accounts are injected into sessions from env and never
 * stored in linked_accounts, so they are synthesized here the same way.
 */
async function resolveShareAccount(accountId, calendarHref) {
  if (accountId === 'internal-caldav') {
    const cleanPath = (calendarHref || '').replace(/^(\\\\|[a-z0-9+-.]+:\/\/|\/\/)[^/]+/i, '');
    const segments = cleanPath.split('/').filter(Boolean);
    const ownerId = segments[0];
    if (!ownerId) return null;
    return {
      id: accountId,
      url: process.env.INTERNAL_CALDAV_URL || 'http://localhost:5232',
      username: ownerId,
      password: process.env.SYSTEM_SYNC_SECRET,
      authType: 'basic'
    };
  }
  if (accountId === 'env-default') {
    if (!process.env.CALDAVURL) return null;
    return {
      id: accountId,
      url: process.env.CALDAVURL,
      username: process.env.CALDAV_USERNAME,
      password: process.env.CALDAV_PASSWORD,
      authType: 'basic'
    };
  }
  return Db.getAccountById(accountId);
}

// ── GET /api/calendars/share-invitations ──────────────────────────────────────
router.get('/share-invitations', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const invitations = await Db.getPendingShareInvitationsForUser(userId);
    res.json({ invitations });
  } catch (err) {
    return sendError(res, err, '[share-invitations GET]');
  }
});

// ── POST /api/calendars/share-invitations/:id/accept ──────────────────────────
router.post('/share-invitations/:id/accept', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const invite = await Db.getShareInvitationById(req.params.id);
    if (!invite) {
      return res.status(404).json({ error: 'Share invitation not found' });
    }

    if (invite.shareeUserId !== userId) {
      return res.status(403).json({ error: 'You are not authorized to respond to this invitation' });
    }

    await Db.updateShareStatus(invite.id, 'ACCEPTED');
    res.json({ message: 'Share invitation accepted', invitationId: invite.id, status: 'ACCEPTED' });
  } catch (err) {
    return sendError(res, err, '[share-invitations accept]');
  }
});

// ── POST /api/calendars/share-invitations/:id/decline ─────────────────────────
router.post('/share-invitations/:id/decline', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const invite = await Db.getShareInvitationById(req.params.id);
    if (!invite) {
      return res.status(404).json({ error: 'Share invitation not found' });
    }

    if (invite.shareeUserId !== userId) {
      return res.status(403).json({ error: 'You are not authorized to respond to this invitation' });
    }

    await Db.updateShareStatus(invite.id, 'DECLINED');
    res.json({ message: 'Share invitation declined', invitationId: invite.id, status: 'DECLINED' });
  } catch (err) {
    return sendError(res, err, '[share-invitations decline]');
  }
});

// GET /api/calendars — fetch all calendars from all accounts
router.get('/', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
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
  ).then(async (results) => {
    await Promise.all(results.map(async (r, i) => {
      if (r.status === 'rejected') {
        const { status, message } = describeError(r.reason);
        errors.push({ accountId: accounts[i].id, status, error: message });
        console.error(`[calendars] Account ${accounts[i].id}:`, r.reason.message);
        if (process.env.DISABLE_INTERNAL_CALDAV === '1' && req.session?.userId) {
          const canonicalUser = req.session.userId;
          allCalendars.push({
            id: `internal-caldav::/${canonicalUser}/personal/`,
            accountId: accounts[i].id,
            name: 'Persönlich',
            color: '#7c3aed',
            href: `/${canonicalUser}/personal/`,
            source: 'local'
          });
        }
      }
    }));
  });

  // Fetch shared calendars for the logged-in user
  const userId = req.session.userId;
  const internalAccount = accounts.find(a => a.id === 'internal-caldav') || accounts[0];
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
              
              const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'http://localhost:5232';
              const calendarUrl = localCalDAVCUrl.replace(/\/+$/, '') + calendarHref;
              
              let fetchedCal = null;
              if (process.env.DISABLE_INTERNAL_CALDAV !== '1') {
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
                    fetchedCal = parsed[0];
                  }
                }
              }

              if (!fetchedCal) {
                fetchedCal = {
                  id: share.calendar_id,
                  accountId: 'internal-caldav',
                  name: calendarHref,
                  color: '#7c3aed',
                  href: calendarHref
                };
              }

              fetchedCal.id = share.calendar_id;
              fetchedCal.readOnly = !share.read_write;
              fetchedCal.isShared = true;
              
              const ownerUuid = calendarHref.split('/').filter(Boolean)[0];
              fetchedCal.owner = (await Db.getUsernameByUserId(ownerUuid)) || ownerUuid;
              
              allCalendars.push(fetchedCal);
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

  // Apply local color overrides for the requesting user
  if (userId) {
    try {
      const colorOverrides = await Db.getUserCalendarColorOverrides(userId);
      for (const cal of allCalendars) {
        if (colorOverrides[cal.id]) {
          cal.color = colorOverrides[cal.id];
        }
      }
    } catch (overrideErr) {
      console.error('[calendars GET] Failed to fetch color overrides:', overrideErr.message);
    }
  }

  if (errors.length > 0) {
    res.setHeader('X-CalDAV-Error', JSON.stringify(errors.map(e => e.error)));
  }

  const allAccountsFailed = accounts.length > 0 && errors.length >= accounts.length && allCalendars.length === 0;
  if (allAccountsFailed) {
    return res.status(errors[0].status).json({
      // The client prefixes "Kalender konnten nicht geladen werden: "; send the cause.
      error: errors[0].error,
      calendars: [],
      errors
    });
  }

  console.log('[calendars route] Returning calendars:', allCalendars.map(c => `${c.accountId}::${c.name} (${c.source})`));

  res.json({ calendars: allCalendars, errors });
});

// POST /api/calendars — create a new calendar collection
router.post('/', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { accountId, name, color } = req.body;

    if (!accountId || !name) {
      return res.status(400).json({ error: 'accountId and name are required' });
    }

    const account = (req.session.accounts || []).find(a => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getClientForAccount(account);

    let slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    // #193: `google-` collections belong to the sync worker's Google pairs.
    if (slug.startsWith('google-')) slug = `local-${slug}`;
    const calendarUrl = account.url.replace(/\/+$/, '') + '/' + slug + '/';
    const createdCalendarId = `${accountId}::${new URL(calendarUrl).pathname}`;

    // Purge any pre-existing/stale share grants for this calendar ID to ensure clean isolation
    await Db.deleteCalendarData(createdCalendarId);

    await client.mkcalendar(calendarUrl, name, color || '#7c3aed');

    queueSyncForCalendar(calendarUrl, req.session.userId);

    res.status(201).json({
      message: 'Calendar created',
      url: calendarUrl,
      id: `${accountId}::${new URL(calendarUrl).pathname}`
    });
  } catch (err) {
    return sendError(res, err, '[calendars POST]');
  }
});

// ── Helper: resolve account + calendar URL from calendarId ──────────────────
async function resolveCalendar(req, calendarId) {
  const sep = calendarId.indexOf('::');
  if (sep === -1) return {};
  const accountId    = calendarId.slice(0, sep);
  const calendarHref = calendarId.slice(sep + 2);
  let account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account && accountId === 'internal-caldav') {
    const userId = req.session?.userId || 'test';
    account = {
      id: 'internal-caldav',
      url: `${process.env.INTERNAL_CALDAV_URL || 'http://localhost:5232'}/${userId}/`,
      username: userId,
      password: process.env.SYSTEM_SYNC_SECRET,
      displayName: 'Interner Kalender'
    };
  }
  if (!account) return {};

  const client = await getClientForAccount(account);
  const calendarUrl = resolveUrl(account.url, calendarHref);

  return { account, client, calendarUrl };
}

// PATCH /api/calendars/:id — rename and/or recolor a calendar
router.patch('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { name, color } = req.body;

    if (name === undefined && color === undefined) {
      return res.status(400).json({ error: 'At least name or color is required' });
    }

    if (name) {
      const access = await checkCalendarAccess(req, calendarId, 'write');
      if (!access.allowed) {
        return res.status(access.status || 403).json({ error: access.reason || 'Write access required to rename calendar' });
      }
    } else {
      const access = await checkCalendarAccess(req, calendarId, 'read');
      if (!access.allowed) {
        return res.status(access.status || 403).json({ error: access.reason });
      }
    }

    if (color !== undefined && req.session?.userId) {
      if (color === null) {
        await Db.deleteUserCalendarColorOverride(req.session.userId, calendarId);
      } else {
        await Db.setUserCalendarColorOverride(req.session.userId, calendarId, color);
      }
    }

    const writeAccess = await checkCalendarAccess(req, calendarId, 'write');
    if (writeAccess.allowed) {
      const { client, calendarUrl } = await resolveCalendar(req, calendarId);
      if (client) {
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

        try {
          const patchRes = await client._request('PROPPATCH', calendarUrl, { body });
          if (!patchRes.ok && patchRes.status !== 207) {
            console.warn(`[calendars PATCH] PROPPATCH returned ${patchRes.status}`);
          }
        } catch (patchErr) {
          console.warn('[calendars PATCH] PROPPATCH error:', patchErr.message);
        }

        queueSyncForCalendar(calendarId, req.session.userId);
      }
    }

    res.json({ message: 'Calendar updated', calendarId, name, color });
  } catch (err) {
    return sendError(res, err, '[calendars PATCH]');
  }
});

// DELETE /api/calendars/:id/color-override — clear local color override
router.delete('/:id/color-override', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    await Db.deleteUserCalendarColorOverride(req.session.userId, calendarId);
    res.json({ message: 'Calendar color override removed', calendarId });
  } catch (err) {
    return sendError(res, err, '[calendars DELETE color-override]');
  }
});

// DELETE /api/calendars/:id — delete a calendar collection and all its events
router.delete('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed || !access.isOwner) {
      return res.status(access.status || 403).json({ error: access.reason || 'Owner permission required to delete calendar' });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const delRes = await client._request('DELETE', calendarUrl);
    if (!delRes.ok && delRes.status !== 204 && delRes.status !== 404) {
      throw new Error(`DELETE ${delRes.status}: ${delRes.statusText}`);
    }

    await Db.deleteCalendarData(calendarId);

    queueSyncForCalendar(calendarId, req.session.userId);

    res.json({ message: 'Calendar deleted', calendarId });
  } catch (err) {
    return sendError(res, err, '[calendars DELETE]');
  }
});

// GET /api/calendars/:id/export — download the whole calendar as a .ics file
router.get('/:id/export', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });
    const slug = new URL(calendarUrl).pathname.split('/').filter(Boolean).pop() || 'calendar';

    // A backend failure must not download as an empty calendar (#341).
    const ics = await fetchCalendarICS(client, calendarUrl);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.ics"`);
    res.send(ics);
  } catch (err) {
    return sendError(res, err, '[calendars export]');
  }
});

// POST /api/calendars/export/pdf — export vector PDF for month or week view
router.post('/export/pdf', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { generateCalendarPDF } = require('../utils/pdfExport');
    const { view, year, month, week, events, title, orientation } = req.body || {};
    if (!view || (view !== 'month' && view !== 'week')) {
      return res.status(400).json({ error: 'Missing or invalid view parameter (must be "month" or "week")' });
    }

    const pdfBuffer = generateCalendarPDF({
      view,
      year: parseInt(year, 10) || new Date().getFullYear(),
      month: parseInt(month, 10) || (new Date().getMonth() + 1),
      week: parseInt(week, 10) || 1,
      events: Array.isArray(events) ? events : [],
      title: title || (view === 'month' ? `Monatsansicht - ${month || ''}/${year || ''}` : `Wochenansicht - KW ${week || 1}`),
      orientation: orientation || 'landscape'
    });

    const filename = `calendar-${view}-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    return sendError(res, err, '[calendars export pdf]');
  }
});


async function fetchExistingCalendarEvents(client, calendarId, accountId, calendarUrl) {
  try {
    const startDate = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const endDate = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    const eventsXml = await client.getEvents(calendarUrl, startDate, endDate);
    const { parseEventList } = require('../caldav/parser');
    return parseEventList(eventsXml, calendarId, accountId, calendarUrl, startDate, endDate);
  } catch (err) {
    console.error('[fetchExistingCalendarEvents]', err.message);
    return [];
  }
}

// POST /api/calendars/:id/import/detect — detect conflicts & duplicates before import
router.post('/:id/import/detect', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { ics } = req.body;
    if (!ics || typeof ics !== 'string') {
      return res.status(400).json({ error: 'ics (string) is required' });
    }

    const { client, account, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const existingEvents = await fetchExistingCalendarEvents(client, calendarId, account ? account.id : 'internal-caldav', calendarUrl);
    const result = detectICSConflicts(ics, existingEvents);

    res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, err, '[calendars import detect]');
  }
});

// POST /api/calendars/:id/import — import events from an uploaded ICS document with conflict resolution
router.post('/:id/import', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { ics, resolutions, defaultStrategy } = req.body;
    if (!ics || typeof ics !== 'string') {
      return res.status(400).json({ error: 'ics (string) is required' });
    }

    const { client, account, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    let comp;
    try {
      comp = new ICAL.Component(ICAL.parse(ics));
    } catch (parseErr) {
      console.warn('[calendars import] ICS parse failed:', parseErr.message);
      return res.status(400).json({ error: 'Ungültige ICS-Datei. Die Datei konnte nicht gelesen werden.' });
    }

    const vevents = comp.getAllSubcomponents('vevent');
    if (vevents.length === 0) {
      return res.status(400).json({ error: 'Die Datei enthält keine Termine.' });
    }
    const vtimezones = comp.getAllSubcomponents('vtimezone');

    // If resolution strategy is provided, process conflicts explicitly
    if (resolutions || defaultStrategy) {
      const existingEvents = await fetchExistingCalendarEvents(client, calendarId, account ? account.id : 'internal-caldav', calendarUrl);
      const resolvedItems = resolveICSImport(ics, existingEvents, resolutions || defaultStrategy);

      let imported = 0, skipped = 0, failed = 0;
      for (const item of resolvedItems) {
        if (item.action === 'SKIP') {
          skipped++;
          continue;
        }

        const doc = new ICAL.Component(['vcalendar', [], []]);
        doc.updatePropertyWithValue('version', '2.0');
        doc.updatePropertyWithValue('prodid', '-//Freeshard//WebCalendar 1.0//EN');
        if (Array.isArray(item.vtimezones)) {
          for (const tz of item.vtimezones) doc.addSubcomponent(tz);
        } else {
          for (const tz of vtimezones) doc.addSubcomponent(tz);
        }
        doc.addSubcomponent(item.veventComp);

        const resourceUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(item.uid) + '.ics';
        try {
          // FORCE put for OVERWRITE (etag=undefined), or etag=null for NEW
          const etagVal = item.action === 'OVERWRITE' ? undefined : null;
          await client.put(resourceUrl, doc.toString(), etagVal);
          imported++;
        } catch (putErr) {
          if (putErr.message === 'ETAG_CONFLICT') skipped++;
          else { failed++; console.error(`[calendars import resolved] ${item.uid}:`, putErr.message); }
        }
      }

      queueSyncForCalendar(calendarId, req.session.userId);
      return res.json({ imported, skipped, failed, total: resolvedItems.length });
    }

    // Default import behavior (group by UID)
    const byUid = new Map();
    for (const v of vevents) {
      const uid = v.getFirstPropertyValue('uid') || crypto.randomUUID();
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(v);
    }

    let imported = 0, skipped = 0, failed = 0;
    for (const [uid, events] of byUid) {
      const doc = new ICAL.Component(['vcalendar', [], []]);
      doc.updatePropertyWithValue('version', '2.0');
      doc.updatePropertyWithValue('prodid', '-//Freeshard//WebCalendar 1.0//EN');
      for (const tz of vtimezones) doc.addSubcomponent(tz);
      for (const v of events) doc.addSubcomponent(v);

      const resourceUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';
      try {
        await client.put(resourceUrl, doc.toString(), null);
        imported++;
      } catch (putErr) {
        if (putErr.message === 'ETAG_CONFLICT') skipped++;
        else { failed++; console.error(`[calendars import] ${uid}:`, putErr.message); }
      }
    }

    queueSyncForCalendar(calendarId, req.session.userId);

    res.json({ imported, skipped, failed, total: byUid.size });
  } catch (err) {
    return sendError(res, err, '[calendars import]');
  }
});

// GET /api/calendars/:id/sync/conflicts — fetch pending two-way sync conflicts
router.get('/:id/sync/conflicts', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const userId = req.session ? req.session.userId : 'testuser';
    const conflicts = await Db.getPendingSyncConflicts(userId, calendarId);
    res.json({ success: true, conflicts });
  } catch (err) {
    return sendError(res, err, '[sync conflicts get]');
  }
});

// POST /api/calendars/:id/sync/resolve-conflict — resolve a specific two-way sync conflict
router.post('/:id/sync/resolve-conflict', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const userId = req.session ? req.session.userId : 'testuser';
    const { conflictId, uid, strategy, customIcs, localIcs, remoteIcs } = req.body;

    if (!strategy) {
      return res.status(400).json({ error: 'strategy is required' });
    }

    let resolvedIcs = customIcs;
    if (!resolvedIcs && (localIcs || remoteIcs)) {
      resolvedIcs = resolveTwoWayConflict(localIcs, remoteIcs, strategy);
    }

    if (conflictId) {
      await Db.resolveSyncConflict(conflictId, userId, strategy, resolvedIcs);
    }

    if (resolvedIcs && uid) {
      const { client, calendarUrl } = await resolveCalendar(req, calendarId);
      if (client && calendarUrl) {
        const resourceUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';
        await client.put(resourceUrl, resolvedIcs, null);
      }
    }

    res.json({ success: true, strategy, resolvedIcs });
  } catch (err) {
    return sendError(res, err, '[sync resolve-conflict post]');
  }
});

// GET /api/calendars/search-users — search principals for sharing
router.get('/search-users', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
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
    return sendError(res, err, '[search-users ERROR]');
  }
});

// GET /api/calendars/:id/shares — list invitees / shares of a calendar
router.get('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { account } = await resolveCalendar(req, calendarId);

    if (account?.id === 'internal-caldav') {
      const shares = await Db.getUserShares(calendarId);
      return res.json({ shares });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const shares = await client.getCalendarShares(calendarUrl);
    res.json({ shares });
  } catch (err) {
    return sendError(res, err, '[shares GET]');
  }
});

// POST /api/calendars/:id/shares — add/update calendar share invitee
router.post('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { sharee, readWrite, role, canViewPrivate, canManageShares } = req.body;
    if (!sharee) return res.status(400).json({ error: 'sharee is required' });

    const { account } = await resolveCalendar(req, calendarId);

    if (account?.id === 'internal-caldav') {
      let shareeUserId = sharee.replace(/\//g, '');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(shareeUserId)) {
        const resolvedUserId = await Db.getUserIdByUsername(shareeUserId);
        if (resolvedUserId) {
          shareeUserId = resolvedUserId;
        } else {
          const resolvedUsername = await Db.getUsernameByUserId(shareeUserId);
          if (!resolvedUsername) {
            return res.status(404).json({ error: `User "${shareeUserId}" not found.` });
          }
        }
      }
      const shareRole = role || (readWrite ? 'WRITE' : 'READ');
      await Db.addUserShare(calendarId, shareeUserId, !!readWrite, 'PENDING', shareRole, !!canViewPrivate, !!canManageShares);
      return res.json({ message: 'Share invite sent.', sharee: shareeUserId, role: shareRole });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.updateCalendarShares(calendarUrl, { href: sharee, readWrite: !!readWrite });
    res.json({ message: 'Share invite sent.' });
  } catch (err) {
    return sendError(res, err, '[shares POST]');
  }
});

// PUT /api/calendars/:id/shares/:shareeId — update granular permissions of a calendar share
router.put('/:id/shares/:shareeId', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    let shareeUserId = decodeURIComponent(req.params.shareeId).replace(/\//g, '');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(shareeUserId)) {
      const resolvedUserId = await Db.getUserIdByUsername(shareeUserId);
      if (resolvedUserId) {
        shareeUserId = resolvedUserId;
      }
    }

    const { role, readWrite, canViewPrivate, canManageShares } = req.body;
    const { account } = await resolveCalendar(req, calendarId);

    if (account?.id === 'internal-caldav') {
      await Db.updateUserSharePermissions(calendarId, shareeUserId, { role, readWrite, canViewPrivate, canManageShares });
      return res.json({ message: 'Share permissions updated.', sharee: shareeUserId });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.updateCalendarShares(calendarUrl, { href: shareeUserId, readWrite: role === 'WRITE' || !!readWrite });
    res.json({ message: 'Share permissions updated.', sharee: shareeUserId });
  } catch (err) {
    return sendError(res, err, '[shares PUT]');
  }
});

// DELETE /api/calendars/:id/shares — remove a share invitee
router.delete('/:id/shares', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { sharee } = req.body;
    if (!sharee) return res.status(400).json({ error: 'sharee parameter is required in request body' });

    const { account } = await resolveCalendar(req, calendarId);

    if (account?.id === 'internal-caldav') {
      let shareeUserId = sharee.replace(/\//g, '');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(shareeUserId)) {
        const resolvedUserId = await Db.getUserIdByUsername(shareeUserId);
        if (resolvedUserId) {
          shareeUserId = resolvedUserId;
        } else {
          const resolvedUsername = await Db.getUsernameByUserId(shareeUserId);
          if (!resolvedUsername) {
            return res.status(404).json({ error: `User "${shareeUserId}" not found.` });
          }
        }
      }
      await Db.removeUserShare(calendarId, shareeUserId);
      return res.json({ message: 'Share removed.' });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.updateCalendarShares(calendarUrl, { href: sharee, remove: true });
    res.json({ message: 'Share removed.' });
  } catch (err) {
    return sendError(res, err, '[shares DELETE]');
  }
});

// GET /api/calendars/:id/public-link — get public webcal status
router.get('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

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

    const detail = (await client.getCustomProperty(calendarUrl, SHARE_NS, 'public-share-detail')) || DEFAULT_DETAIL;
    res.json({
      enabled: true,
      url: getPublicShareUrl(req, token),
      detail
    });
  } catch (err) {
    return sendError(res, err, '[public-link GET]');
  }
});

// POST /api/calendars/:id/public-link — enable/generate public link
router.post('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

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

    const detail = (await client.getCustomProperty(calendarUrl, SHARE_NS, 'public-share-detail')) || DEFAULT_DETAIL;
    res.json({
      enabled: true,
      url: getPublicShareUrl(req, token),
      detail
    });
  } catch (err) {
    return sendError(res, err, '[public-link POST]');
  }
});

// DELETE /api/calendars/:id/public-link — disable public link
router.delete('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    await client.setCustomProperty(calendarUrl, 'http://freeshard.de/ns/', 'public-share-token', null);
    await client.setCustomProperty(calendarUrl, SHARE_NS, 'public-share-detail', null);
    res.json({ enabled: false, message: 'Public share link disabled.' });
  } catch (err) {
    return sendError(res, err, '[public-link DELETE]');
  }
});

// PUT /api/calendars/:id/public-link — set the detail level ('busy' | 'full') of the public link
router.put('/:id/public-link', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { detail } = req.body || {};
    if (!isValidDetail(detail)) {
      return res.status(400).json({ error: 'Ungültige Detailstufe.' });
    }

    const { client, calendarUrl } = await resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const saved = await client.setCustomProperty(calendarUrl, SHARE_NS, 'public-share-detail', detail);
    if (!saved) throw userError('Detailstufe konnte nicht gespeichert werden.', 502);
    res.json({ detail });
  } catch (err) {
    return sendError(res, err, '[public-link PUT]');
  }
});

// ── Multiple Public Shares (Token-based) API ────────────────────────────────

// GET /api/calendars/:id/shares-public — list all public share tokens
router.get('/:id/shares-public', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const shares = await Db.getCalendarShares(calendarId);
    res.json(shares.map(s => ({
      token: s.token,
      label: s.label,
      createdAt: s.createdAt,
      detail: s.detail,
      url: getPublicShareUrl(req, s.token)
    })));
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/calendars/:id/shares-public — create a new public share token
router.post('/:id/shares-public', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { label, detail = DEFAULT_DETAIL } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'Bezeichnung ist erforderlich.' });
    }
    if (!isValidDetail(detail)) {
      return res.status(400).json({ error: 'Ungültige Detailstufe.' });
    }
    const share = await Db.addCalendarShare(calendarId, label.trim(), detail);
    res.status(201).json({
      token: share.token,
      label: share.label,
      createdAt: share.createdAt,
      detail: share.detail,
      url: getPublicShareUrl(req, share.token)
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// DELETE /api/calendars/:id/shares-public/:token — revoke/delete public share token
router.delete('/:id/shares-public/:token', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'owner');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const share = await Db.getCalendarShareByToken(req.params.token);
    if (!share || share.calendar_id !== calendarId) {
      return res.status(404).json({ error: 'Share token not found for this calendar' });
    }

    await Db.deleteCalendarShare(req.params.token, calendarId);
    res.json({ message: 'Freigabe-Link widerrufen.' });
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/calendars/:id/delta-sync — RFC 6578 sync-collection delta sync endpoint
router.post('/:id/delta-sync', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }
    const accounts = req.session.accounts || [];
    const sepIdx = calendarId.indexOf('::');
    if (sepIdx === -1) {
      return res.status(400).json({ error: 'Ungültiges Kalender-ID Format.' });
    }

    const accountId = calendarId.substring(0, sepIdx);
    const calendarHref = calendarId.substring(sepIdx + 2);
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      return res.status(404).json({ error: 'Konto nicht gefunden.' });
    }

    const client = await getClientForAccount(account);
    const calendarUrl = resolveUrl(account.url, calendarHref);

    const cached = await Db.getCalendarSyncCache(calendarId);
    const tokenToUse = req.body?.syncToken || cached?.syncToken || null;

    const ctag = req.body?.ctag || cached?.ctag || null;

    // A token the server rejects (RFC 6578 §3.2) is replaced by a full sync inside the client.
    const { xml, fallbackPerformed } = await client.syncCollectionWithFallback(calendarUrl, tokenToUse);
    if (fallbackPerformed) {
      await Db.upsertCalendarSyncCache(calendarId, ctag, null);
    }

    const parsed = parseSyncCollectionResponse(xml, calendarId, accountId, calendarUrl);
    if (parsed.invalidSyncToken) {
      throw new Error('[delta-sync] Server rejected a sync-collection REPORT without a sync token');
    }

    const { syncToken, updated, deleted } = parsed;

    if (syncToken) {
      await Db.upsertCalendarSyncCache(calendarId, ctag, syncToken);
    }

    // Unchanged only when the server confirmed an existing token and reported an empty delta.
    const ctagChanged = !tokenToUse || fallbackPerformed || !syncToken ||
      updated.length > 0 || deleted.length > 0;

    res.json({
      calendarId,
      ctagChanged,
      syncToken,
      updated,
      deleted,
      fallbackPerformed
    });
  } catch (err) {
    return sendError(res, err, '[delta-sync] Error executing delta sync:');
  }
});

// POST /api/calendars/:id/sync-queue — Enqueue sync job with owner authorization verification
router.post('/:id/sync-queue', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }
    const userId = req.session.userId;
    const job = await Db.addSyncJob(userId);
    await queueSyncForCalendar(calendarId, userId);
    res.status(201).json({ success: true, job });
  } catch (err) {
    return sendError(res, err);
  }
});

// GET /api/calendars/sync-queue/status — Get sync queue status and retry info for active session user
router.get('/sync-queue/status', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    const { getSyncQueueStatus } = require('../utils/syncRetryQueue');
    const status = await getSyncQueueStatus(req.session.userId);
    res.json(status);
  } catch (err) {
    return sendError(res, err);
  }
});

// POST /api/calendars/sync-queue/retry — Reset failed retries and enqueue immediate sync job
router.post('/sync-queue/retry', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    const { resetSyncJobRetries } = require('../utils/syncRetryQueue');
    const job = await resetSyncJobRetries(req.session.userId);
    res.status(201).json({ success: true, job });
  } catch (err) {
    return sendError(res, err);
  }
});

function escXML(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  protectedRouter: router,
  publicRouter: publicRouter,
  resolveCalendar,
  queueSyncForCalendar,
  fetchCalendarICS
};
