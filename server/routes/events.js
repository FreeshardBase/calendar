'use strict';

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { parseCalendarList, parseEventList, eventToICS } = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');

// ── GET /api/events?start=ISO&end=ISO ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required (ISO 8601)' });
    }

    const startDate = new Date(start);
    const endDate   = new Date(end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const accounts = req.session.accounts || [];
    const allEvents = [];

    await Promise.allSettled(
      accounts.map(async (account) => {
        const client = await getClientForAccount(account);

        const calXml    = await client.getCalendars();
        const calendars = parseCalendarList(calXml, account.id, account.url, account.username);

        await Promise.allSettled(
          calendars.map(async (cal) => {
            const eventsXml = await client.getEvents(cal.url, startDate, endDate);
            const events    = parseEventList(eventsXml, cal.id, account.id, cal.url, startDate, endDate);
            allEvents.push(...events);
          })
        );
      })
    );

    res.json(allEvents);
  } catch (err) {
    console.error('[events GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/events — create a new event ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { calendarId, ...eventData } = req.body;

    if (!calendarId) {
      return res.status(400).json({ error: 'calendarId is required' });
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const uid = uuidv4();
    const event = { ...eventData, uid };
    const ics = eventToICS(event);

    // Build event URL — URL-encode the filename to handle special chars
    const calendarHref = calendarId.split('::').slice(1).join('::');
    const calendarUrl  = buildAbsoluteUrl(account.url, calendarHref);
    const eventUrl     = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';

    const result = await client.put(eventUrl, ics, null);
    
    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
    }

    res.status(201).json({
      ...event,
      href:       eventUrl,
      etag:       result.etag ? result.etag.replace(/"/g, '') : null,
      calendarId
    });
  } catch (err) {
    console.error('[events POST]', err.message);
    if (err.message === 'ETAG_CONFLICT') return res.status(409).json({ error: 'Conflict.' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/events/:uid — update an existing event ───────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href, ...eventData } = req.body;

    if (!href)       return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const masterUid = req.params.uid.split('::')[0];
    const event     = { ...eventData, uid: masterUid };
    const ics   = eventToICS(event);

    const eventUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch  = etag ? (etag.startsWith('"') ? etag : `"${etag}"`) : null;

    const result = await client.put(eventUrl, ics, ifMatch, 'text/calendar; charset=utf-8');
    
    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
    }

    res.json({
      ...event,
      href,
      etag:       result.etag ? result.etag.replace(/"/g, '') : etag,
      calendarId
    });
  } catch (err) {
    console.error('[events PUT]', err.message);
    if (err.message === 'ETAG_CONFLICT') {
      return res.status(409).json({
        error: 'This event was modified by another client. Please refresh.'
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/events/:uid ───────────────────────────────────────────────────
router.delete('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href } = req.body;

    if (!href)       return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const eventUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch  = etag ? (etag.startsWith('"') ? etag : `"${etag}"`) : null;

    await client.delete(eventUrl, ifMatch);
    
    if (req.session.userId) {
      Db.addSyncJob(req.session.userId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
    }

    res.json({ message: 'Event deleted.' });
  } catch (err) {
    console.error('[events DELETE]', err.message);
    if (err.message === 'ETAG_CONFLICT') {
      return res.status(409).json({
        error: 'Event was modified externally. Please refresh before deleting.'
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveAccount(req, calendarId) {
  const accountId = calendarId.split('::')[0];
  const account   = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) return { account: null, client: null };

  const client = await getClientForAccount(account);

  return { account, client };
}

/**
 * Build an absolute URL. If href is already absolute, return it.
 * Otherwise resolve relative to the account base URL.
 */
function buildAbsoluteUrl(baseUrl, href) {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return baseUrl.replace(/\/+$/, '') + '/' + href.replace(/^\/+/, '');
  }
}

module.exports = router;
