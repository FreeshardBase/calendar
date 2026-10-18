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
const { sortByUserOrder } = require('../utils/calendarOrder');
const { startImportJob, getImportJob } = require('../utils/importJobs');
const { ICS_CACHE_TTL_SECONDS, ICS_RATE_LIMIT_MAX, ICS_RATE_LIMIT_WINDOW_SECONDS } = require('../utils/icsPublicShareCache');
const { getPublicShareUrl } = require('../utils/baseUrl');
const { sendError, describeError, userError, MESSAGES } = require('../utils/errorSanitizer');
const { sanitizePublicIcs, isValidDetail, DEFAULT_DETAIL } = require('../utils/publicIcs');

const SHARE_NS = 'http://freeshard.de/ns/';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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

if (secretKey.length !== 32) {
  throw new Error(`${keyPath} must hold a 32-byte key, found ${secretKey.length} bytes`);
}

// Subscription-link tokens (#525): AES-256-GCM, so a modified token fails the tag
// check before anything is parsed. The payload names the calendar only; the
// public route resolves the account itself, so no credential is ever embedded.
const TOKEN_FORMAT = /^([0-9a-f]{24}):([0-9a-f]+):([0-9a-f]{32})$/;

function encryptToken({ id, url, publicShareId }) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ id, url, publicShareId }), 'utf8'), cipher.final()]);
  return `${nonce.toString('hex')}:${ct.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

// Returns the payload, or null when the token is malformed or fails authentication.
function decryptToken(token) {
  const m = TOKEN_FORMAT.exec(token);
  if (!m) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(m[1], 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(m[3], 'hex'));
  const ct = Buffer.from(m[2], 'hex');
  let plain;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    // final() throws exactly when the GCM tag does not verify: a forged or altered token.
    if (/authenticate/i.test(err.message)) return null;
    throw err;
  }
  return JSON.parse(plain.toString('utf8'));
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

// #500: a collection is a Kalender (events), an Aufgabenliste (tasks) or, explicitly, both.
const COLLECTION_COMPONENTS = {
  calendar: ['VEVENT'],
  tasklist: ['VTODO'],
  mixed: ['VEVENT', 'VTODO'],
};

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
      
      // Auto-create a default calendar and a default task list for new users on internal-caldav (#500)
      if (account.id === 'internal-caldav' && calendars.length === 0) {
        console.log(`[calendars] Creating default collections 'personal' and 'tasks' for user: ${account.username}`);
        try {
          const home = account.url.replace(/\/+$/, '');
          await client.mkcalendar(home + '/personal/', 'Persönlich', '#7c3aed', COLLECTION_COMPONENTS.calendar);
          await client.mkcalendar(home + '/tasks/', 'Aufgaben', '#0891b2', COLLECTION_COMPONENTS.tasklist);
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
            source: 'local',
            supportsVEVENT: true,
            supportsVTODO: false
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
    <c:supported-calendar-component-set/>
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
                  href: calendarHref,
                  supportsVEVENT: true,
                  supportsVTODO: false
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

  // #496: the linked account a calendar belongs to, so the pickers can label it with that
  // account's name. Mirrored collections live in the user's own Radicale principal; a live
  // account's calendars belong to the account itself.
  const mirroredAccounts = await Db.getMirroredCollectionAccounts(userId);
  for (const cal of allCalendars) {
    if (cal.isShared) {
      cal.linkedAccountId = null;
    } else if (cal.accountId === 'internal-caldav') {
      const collectionName = cal.href.replace(/\/$/, '').split('/').pop();
      cal.linkedAccountId = mirroredAccounts.get(collectionName) || null;
    } else {
      cal.linkedAccountId = cal.accountId;
    }
  }

  // #504: the user's sidebar order; unordered calendars keep their place after the ordered ones.
  sortByUserOrder(allCalendars, await Db.getUserCalendarOrder(userId), cal => cal.id);

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

// PUT /api/calendars/order — #504: store the order of one sidebar group (calendars, task lists or
// subscriptions as `webcal::<id>`). The order is the user's own preference, so any id may be stored;
// only the user's own CalDAV collections also get apple:calendar-order for native clients.
router.put('/order', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { calendarIds } = req.body || {};
    if (!Array.isArray(calendarIds) || calendarIds.length === 0 || calendarIds.length > 500
        || !calendarIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 2048)
        || new Set(calendarIds).size !== calendarIds.length) {
      return res.status(400).json({ error: 'calendarIds must be a non-empty list of distinct calendar ids' });
    }

    await Db.setUserCalendarOrder(req.session.userId, calendarIds);

    // One PROPPATCH at a time: Radicale drops connections when a long group arrives all at once.
    for (const [position, calendarId] of calendarIds.entries()) {
      if (calendarId.startsWith('webcal::')) continue;
      const access = await checkCalendarAccess(req, calendarId, 'write');
      if (!access.allowed || !access.isOwner) continue;
      const { client, calendarUrl } = await resolveCalendar(req, calendarId);
      if (!client) continue;
      const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">
  <d:set>
    <d:prop>
      <a:calendar-order>${position + 1}</a:calendar-order>
    </d:prop>
  </d:set>
</d:propertyupdate>`;
      const patchRes = await client._request('PROPPATCH', calendarUrl, { body });
      if (!patchRes.ok && patchRes.status !== 207) {
        // The server does not support the property; the stored order still applies here.
        console.warn(`[calendars PUT order] PROPPATCH ${calendarId} returned ${patchRes.status}`);
      }
    }

    res.json({ calendarIds });
  } catch (err) {
    return sendError(res, err, '[calendars PUT order]');
  }
});

// POST /api/calendars — create a new calendar collection
router.post('/', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { accountId, name, color, type } = req.body;

    if (!accountId || !name) {
      return res.status(400).json({ error: 'accountId and name are required' });
    }
    if (!Object.hasOwn(COLLECTION_COMPONENTS, type)) {
      return res.status(400).json({ error: `type must be one of ${Object.keys(COLLECTION_COMPONENTS).join(', ')}` });
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

    await client.mkcalendar(calendarUrl, name, color || '#7c3aed', COLLECTION_COMPONENTS[type]);

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
    // #534: the colour is stored as the user's override and rendered into the UI; only #rrggbb.
    if (color !== undefined && color !== null && !(typeof color === 'string' && HEX_COLOR.test(color))) {
      return res.status(400).json({ error: 'color must be a #rrggbb hex colour' });
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

    const writeAccess = await checkCalendarAccess(req, calendarId, 'write');
    // #505: on a calendar the user may write, colour and name live in the collection, where the sync
    // worker's metasync carries them to the linked account. A read-only calendar only gets the user's
    // local override (#4), which never reaches the collection and so is never pushed upstream.
    if (!writeAccess.allowed) {
      if (color === null) {
        await Db.deleteUserCalendarColorOverride(req.session.userId, calendarId);
      } else if (color !== undefined) {
        await Db.setUserCalendarColorOverride(req.session.userId, calendarId, color);
      }
      return res.json({ message: 'Calendar updated', calendarId, name, color });
    }

    if (name || color) {
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
      const patchXml = await patchRes.text();
      // A 207 carries one status per property; any non-2xx one means the change was not stored.
      const refused = patchXml.match(/<(?:[\w-]+:)?status>\s*HTTP\/\d\.\d\s+([013-9]\d\d)\b/i);
      if ((!patchRes.ok && patchRes.status !== 207) || refused) {
        throw new Error(`PROPPATCH ${refused ? refused[1] : patchRes.status}`);
      }
      queueSyncForCalendar(calendarId, req.session.userId);
    }
    // An override would hide the collection's colour, and with it every colour synced from the provider.
    if (color !== undefined) {
      await Db.deleteUserCalendarColorOverride(req.session.userId, calendarId);
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

// GET /api/calendars/import-jobs/:jobId — progress of a running ICS import (#174)
router.get('/import-jobs/:jobId', (req, res) => {
  const job = getImportJob(req.params.jobId, req.session.userId);
  if (!job) return res.status(404).json({ error: 'Import nicht gefunden.' });
  res.json(job);
});

function importDocument(vtimezones, vevents) {
  const doc = new ICAL.Component(['vcalendar', [], []]);
  doc.updatePropertyWithValue('version', '2.0');
  doc.updatePropertyWithValue('prodid', '-//Freeshard//WebCalendar 1.0//EN');
  for (const tz of vtimezones) doc.addSubcomponent(tz);
  for (const v of vevents) doc.addSubcomponent(v);
  return doc.toString();
}

// POST /api/calendars/:id/import — import events from an uploaded ICS document with conflict resolution.
// Radicale's create cost grows with the collection (#174), so the PUTs run as a background job:
// the answer is 202 with the job, whose progress GET /api/calendars/import-jobs/:jobId reports.
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

    const items = [];
    let skipped = 0;
    if (resolutions || defaultStrategy) {
      // If resolution strategy is provided, process conflicts explicitly
      const existingEvents = await fetchExistingCalendarEvents(client, calendarId, account ? account.id : 'internal-caldav', calendarUrl);
      for (const item of resolveICSImport(ics, existingEvents, resolutions || defaultStrategy)) {
        if (item.action === 'SKIP') {
          skipped++;
          continue;
        }
        items.push({
          uid: item.uid,
          ics: importDocument(Array.isArray(item.vtimezones) ? item.vtimezones : vtimezones, [item.veventComp]),
          // FORCE put for OVERWRITE (etag=undefined), or etag=null for NEW
          etag: item.action === 'OVERWRITE' ? undefined : null
        });
      }
    } else {
      // Default import behavior (group by UID)
      const byUid = new Map();
      for (const v of vevents) {
        const uid = v.getFirstPropertyValue('uid') || crypto.randomUUID();
        if (!byUid.has(uid)) byUid.set(uid, []);
        byUid.get(uid).push(v);
      }
      for (const [uid, events] of byUid) {
        items.push({ uid, ics: importDocument(vtimezones, events), etag: null });
      }
    }

    const userId = req.session.userId;
    const job = startImportJob({
      userId, calendarId, calendarUrl, client, items, skipped,
      onFinished: () => queueSyncForCalendar(calendarId, userId)
    });
    res.status(202).json(job);
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

// #121: an internal share names a user who has signed in to this shard (by user id or username);
// null for anyone else, so no share is stored against a principal in no table.
function resolveInternalSharee(sharee) {
  return Db.getUserIdByUsername(String(sharee).replace(/\//g, ''));
}

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
      const shareeUserId = await resolveInternalSharee(sharee);
      if (!shareeUserId) return res.status(404).json({ error: `User "${sharee}" not found.` });
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
      const shareeUserId = await resolveInternalSharee(sharee);
      if (!shareeUserId) return res.status(404).json({ error: `User "${sharee}" not found.` });
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

    const token = encryptToken({ id: account.id, url: calendarUrl, publicShareId: activeTokenId });

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

    const token = encryptToken({ id: account.id, url: calendarUrl, publicShareId });

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

    const { syncToken, updated, deleted, unparseable } = parsed;

    if (syncToken) {
      await Db.upsertCalendarSyncCache(calendarId, ctag, syncToken);
    }

    // Unchanged only when the server confirmed an existing token and reported an
    // empty delta; a changed resource that could not be parsed is a change too (#208).
    const ctagChanged = !tokenToUse || fallbackPerformed || !syncToken ||
      updated.length > 0 || deleted.length > 0 || unparseable.length > 0;

    res.json({
      calendarId,
      ctagChanged,
      syncToken,
      updated,
      deleted,
      unparseable,
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
