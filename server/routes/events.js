'use strict';

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { formatIfMatch } = require('../caldav/client');
const {
  parseCalendarList,
  parseEventList,
  parseICSToEvent,
  eventToICS,
  addOccurrenceException,
  upsertOccurrenceOverride,
  buildItipReply,
  isNoOpEventSave,
  updateWholeSeries,
  resolveUrl
} = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { checkCalendarAccess, extractCalendarIdFromHref, queueSyncForCalendar } = require('../utils/calendarAuth');
const { logEventChange } = require('../utils/eventHistory');
const { sanitizeErrorMessage } = require('../utils/errorSanitizer');

async function getUserEmailsForSession(req) {
  const emails = new Set();
  if (req.session?.userEmail) emails.add(req.session.userEmail.toLowerCase().trim());
  if (req.session?.username) emails.add(req.session.username.toLowerCase().trim());
  if (req.session?.userId) emails.add(req.session.userId.toLowerCase().trim());

  if (Array.isArray(req.session?.accounts)) {
    for (const acc of req.session.accounts) {
      if (acc.username) emails.add(acc.username.toLowerCase().trim());
    }
  }

  if (req.session?.userId) {
    try {
      const dbUsername = await Db.getUsernameByUserId(req.session.userId);
      if (dbUsername) emails.add(dbUsername.toLowerCase().trim());
    } catch (_) {}
    try {
      const userAccounts = await Db.getAccounts(req.session.userId);
      if (Array.isArray(userAccounts)) {
        for (const acc of userAccounts) {
          if (acc.username) emails.add(acc.username.toLowerCase().trim());
        }
      }
    } catch (_) {}
  }

  return Array.from(emails);
}

// ── GET /api/events/invitations ───────────────────────────────────────────────
router.get('/invitations', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const accounts = req.session.accounts || [];
    const activeAccounts = accounts.filter(account => account.authType !== 'oauth2');
    const invitations = [];

    const now = new Date();
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const validEmails = await getUserEmailsForSession(req);
    const seenUids = new Set();

    await Promise.allSettled(
      activeAccounts.map(async (account) => {
        const client = await getClientForAccount(account);
        const calXml = await client.getCalendars();
        const calendars = parseCalendarList(calXml, account.id, account.url, account.username);

        await Promise.allSettled(
          calendars.map(async (cal) => {
            try {
              const eventsXml = await client.getEvents(cal.url, startDate, endDate);
              const events = parseEventList(eventsXml, cal.id, account.id, cal.url, startDate, endDate);
              for (const ev of events) {
                if (!ev.uid || seenUids.has(ev.uid)) continue;
                if (Array.isArray(ev.attendees) && ev.attendees.length > 0) {
                  const matchedAtt = ev.attendees.find(a =>
                    validEmails.includes((a.email || '').toLowerCase().replace(/^mailto:/i, '').trim())
                  );
                  if (!matchedAtt) continue;

                  const status = (matchedAtt.status || matchedAtt.partstat || 'NEEDS-ACTION').toUpperCase();
                  if (status === 'ACCEPTED' || status === 'DECLINED' || status === 'DELEGATED') continue;

                  ev.userEmail = matchedAtt.email;
                  seenUids.add(ev.uid);
                  invitations.push(ev);
                }
              }
            } catch (e) {
              console.error(`[invitations GET] Error for ${cal.id}:`, e.message);
            }
          })
        );
      })
    );

    res.json(invitations);
  } catch (err) {
    console.error('[invitations GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── GET /api/events?start=ISO&end=ISO ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { start, end, calendarId } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required (ISO 8601)' });
    }

    if (calendarId) {
      const access = await checkCalendarAccess(req, calendarId, 'read');
      if (!access.allowed) {
        return res.status(access.status || 403).json({ error: access.reason });
      }
    }

    const startDate = new Date(start);
    const endDate   = new Date(end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const accounts = req.session.accounts || [];
    const allEvents = [];
    const errors = [];
    let successfulCalendars = 0;

    // Only query events from local/non-oauth accounts to avoid duplication,
    // since oauth2 accounts are synced in the background.
    const activeAccounts = accounts.filter(account => account.authType !== 'oauth2');

    const hasCalDAVEnv = Boolean(process.env.CALDAVURL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD);
    await Promise.allSettled(
      activeAccounts.map(async (account) => {
        if (
          (account.id === 'internal-caldav' && process.env.DISABLE_INTERNAL_CALDAV === '1') ||
          (account.id === 'env-default' && !hasCalDAVEnv && process.env.DISABLE_INTERNAL_CALDAV === '1')
        ) {
          return;
        }
        try {
          const client = await getClientForAccount(account);

          const calXml    = await client.getCalendars();
          let calendars = parseCalendarList(calXml, account.id, account.url, account.username);

          // Fetch shared calendars for this user if this is the internal-caldav account
          if (account.id === 'internal-caldav' && req.session.userId) {
            try {
              const sharedCals = await Db.getSharedCalendarsForUser(req.session.userId);
              for (const share of sharedCals) {
                const parts = share.calendar_id.split('::');
                const calendarHref = parts[1];
                
                const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://caldav-server:5232';
                const calendarUrl = localCalDAVCUrl.replace(/\/+$/, '') + calendarHref;
                
                calendars.push({
                  id: share.calendar_id,
                  url: calendarUrl,
                  name: calendarHref,
                  color: '#cccccc'
                });
              }
            } catch (dbErr) {
              console.error('[events GET] Failed to fetch shared calendars:', dbErr.message);
            }
          }

          if (calendarId) {
            calendars = calendars.filter(c => c.id === calendarId);
          }

          await Promise.allSettled(
            calendars.map(async (cal) => {
              try {
                const eventsXml = await client.getEvents(cal.url, startDate, endDate);
                const events    = parseEventList(eventsXml, cal.id, account.id, cal.url, startDate, endDate);
                allEvents.push(...events);
                successfulCalendars++;
              } catch (eventErr) {
                console.error(`[events GET] Failed to fetch events for calendar ${cal.id}:`, eventErr.message);
                errors.push({ accountId: account.id, calendarId: cal.id, error: eventErr.message });
              }
            })
          );
        } catch (accountErr) {
          console.error(`[events GET] Failed to fetch calendars for account ${account.id}:`, accountErr.message);
          errors.push({ accountId: account.id, error: accountErr.message });
        }
      })
    );

    if (errors.length > 0) {
      res.setHeader('X-CalDAV-Error', JSON.stringify(errors.map(e => e.error)));
    }

    const specificCalendarFailed = calendarId && errors.some(e => e.calendarId === calendarId);
    const allAccountsFailed = activeAccounts.length > 0 && errors.length >= activeAccounts.length && successfulCalendars === 0;

    if (specificCalendarFailed || allAccountsFailed) {
      return res.status(502).json({
        error: 'Failed to fetch events from CalDAV server',
        errors
      });
    }

    let filteredEvents = allEvents;
    if (req.query.category || req.query.tag) {
      const target = String(req.query.category || req.query.tag).trim().toLowerCase();
      filteredEvents = filteredEvents.filter(ev =>
        Array.isArray(ev.categories) && ev.categories.some(c => String(c).trim().toLowerCase() === target)
      );
    }

    res.json(filteredEvents);
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

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
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
    
    queueSyncForCalendar(calendarId, req.session.userId);

    await logEventChange({
      eventUid: uid,
      calendarId,
      userId: req.session.userId,
      action: 'CREATE',
      newEvent: event,
      snapshotIcs: ics
    }).catch(err => console.error('[events POST history]', err.message));

    res.status(201).json({
      ...event,
      href:       eventUrl,
      etag:       result.etag || null,
      calendarId
    });
  } catch (err) {
    console.error('[events POST]', err.message);
    if (err.message === 'ETAG_CONFLICT') return res.status(409).json({ error: 'Conflict.' });
    res.status(500).json({ error: sanitizeErrorMessage(err.message) });
  }
});

// ── PUT /api/events/:uid — update an existing event ───────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href, scope, recurrenceId, ...eventData } = req.body;

    if (!href)       return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    if (derivedCalId && derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const masterUid = req.params.uid.split('::')[0];
    const event     = { ...eventData, uid: masterUid };
    const eventUrl  = buildAbsoluteUrl(account.url, href);

    let ics;
    let ifMatch;
    let existingIcs = null;
    if (scope === 'occurrence' && recurrenceId) {
      // Edit a single occurrence: write a detached exception VEVENT into the
      // existing resource instead of replacing the whole series.
      const current = await client.get(eventUrl);
      existingIcs = current ? current.ics : null;
      if (current && current.ics && isNoOpEventSave(current.ics, eventData, recurrenceId)) {
        queueSyncForCalendar(calendarId, req.session.userId);
        return res.json({
          ...event,
          href,
          etag: (current && current.etag) ? current.etag : etag,
          calendarId
        });
      }
      ics     = upsertOccurrenceOverride(current.ics, recurrenceId, eventData);
      ifMatch = current.etag;
    } else {
      let current = null;
      try {
        current = await client.get(eventUrl);
      } catch (_) {
        current = null;
      }
      existingIcs = current ? current.ics : null;

      if (current && current.ics && isNoOpEventSave(current.ics, eventData)) {
        queueSyncForCalendar(calendarId, req.session.userId);
        return res.json({
          ...event,
          href,
          etag: (current && current.etag) ? current.etag : etag,
          calendarId
        });
      }

      ics     = updateWholeSeries(current ? current.ics : null, event);
      ifMatch = etag ? formatIfMatch(etag) : null;
    }

    let result;
    try {
      result = await client.put(eventUrl, ics, ifMatch);
    } catch (putErr) {
      if (putErr.message === 'ETAG_CONFLICT') {
        result = await client.put(eventUrl, ics, false);
      } else {
        throw putErr;
      }
    }
    
    queueSyncForCalendar(calendarId, req.session.userId);

    const oldEvent = existingIcs ? parseICSToEvent(existingIcs) : null;
    await logEventChange({
      eventUid: masterUid,
      calendarId,
      userId: req.session.userId,
      action: 'UPDATE',
      oldEvent,
      newEvent: event,
      snapshotIcs: ics
    }).catch(err => console.error('[events PUT history]', err.message));

    res.json({
      ...event,
      href,
      etag:       (result && result.etag) ? result.etag : etag,
      calendarId
    });
  } catch (err) {
    console.error('[events PUT]', err.message);
    if (err.message === 'ETAG_CONFLICT') {
      return res.status(409).json({
        error: 'This event was modified by another client. Please refresh.'
      });
    }
    res.status(500).json({ error: sanitizeErrorMessage(err.message) });
  }
});

// ── DELETE /api/events/:uid ───────────────────────────────────────────────────
router.delete('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href, scope, recurrenceId } = req.body;

    if (!href)       return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    if (derivedCalId && derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const eventUrl = buildAbsoluteUrl(account.url, href);

    if (scope === 'occurrence' && recurrenceId) {
      // Delete a single occurrence: EXDATE it in the master instead of
      // deleting the whole series resource.
      const current = await client.get(eventUrl);
      const ics = addOccurrenceException(current.ics, recurrenceId);
      await client.put(eventUrl, ics, current.etag);
      queueSyncForCalendar(calendarId, req.session.userId);
      return res.json({ message: 'Occurrence deleted.' });
    }

    const ifMatch  = etag ? formatIfMatch(etag) : null;

    try {
      await client.delete(eventUrl, ifMatch);
    } catch (delErr) {
      if (delErr.message === 'ETAG_CONFLICT') {
        await client.delete(eventUrl, null);
      } else {
        throw delErr;
      }
    }
    
    // Check if actor is different from owner of the calendar
    const calParts = calendarId.split('::');
    if (calParts[0] === 'internal-caldav' && calParts[1]) {
      const calSegments = calParts[1].split('/').filter(Boolean);
      const ownerUserId = calSegments[0];
      if (ownerUserId && req.session && req.session.userId && req.session.userId !== ownerUserId) {
        await Db.recordCrossUserDeletion(req.params.uid, calendarId, ownerUserId, req.session.userId).catch(err => {
          console.error('[events DELETE] Failed to record cross-user deletion:', err.message);
        });
      }
    }

    queueSyncForCalendar(calendarId, req.session.userId);

    await logEventChange({
      eventUid: req.params.uid.split('::')[0],
      calendarId,
      userId: req.session.userId,
      action: 'DELETE',
      oldEvent: { title: href }
    }).catch(err => console.error('[events DELETE history]', err.message));

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

// ── POST /api/events/:uid/rsvp ────────────────────────────────────────────────
router.post('/:uid/rsvp', async (req, res) => {
  try {
    const { calendarId, href, email, status, recurrenceId } = req.body;

    if (!href || !calendarId || !status) {
      return res.status(400).json({ error: 'calendarId, href, and status are required' });
    }

    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    if (derivedCalId && derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'read');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const eventUrl = buildAbsoluteUrl(account.url, href);
    const current = await client.get(eventUrl);

    // Issue #67 & #77: Validate user email against session identity and event attendees
    const parsedCurrent = parseICSToEvent(current.ics);
    const attendees = parsedCurrent?.attendees || [];
    const validEmails = await getUserEmailsForSession(req);

    let rsvpEmail = (email || '').toLowerCase().replace(/^mailto:/i, '').trim();

    if (rsvpEmail) {
      const isUserEmail = validEmails.some(ve => ve === rsvpEmail);
      if (!isUserEmail && validEmails.length > 0) {
        return res.status(403).json({ error: 'Unauthorized email address for RSVP' });
      }
    } else {
      const matched = attendees.find(a => {
        const aEmail = (a.email || '').toLowerCase().replace(/^mailto:/i, '').trim();
        return validEmails.includes(aEmail);
      });
      if (matched) {
        rsvpEmail = (matched.email || '').toLowerCase().replace(/^mailto:/i, '').trim();
      } else {
        return res.status(400).json({ error: 'User email not found among event attendees' });
      }
    }

    const isAttendee = attendees.some(a => (a.email || '').toLowerCase().replace(/^mailto:/i, '').trim() === rsvpEmail);
    if (!isAttendee) {
      return res.status(400).json({ error: 'Attendee email not found on event' });
    }

    const updatedIcs = updateAttendeePartstat(current.ics, rsvpEmail, status, recurrenceId);
    const result = await client.put(eventUrl, updatedIcs, current.etag);

    const parsedEv = parseICSToEvent(updatedIcs, { recurrenceId });
    const eventForReply = { ...(parsedEv || { uid: req.params.uid, title: 'Event' }), recurrenceId: recurrenceId || parsedEv?.recurrenceId };
    const itipReply = buildItipReply(eventForReply, rsvpEmail, status);

    queueSyncForCalendar(calendarId, req.session.userId);

    await logEventChange({
      eventUid: req.params.uid,
      calendarId,
      userId: req.session.userId,
      action: 'RSVP',
      newEvent: { status, recurrenceId }
    }).catch(err => console.error('[events RSVP history]', err.message));

    res.json({
      success: true,
      status,
      recurrenceId: recurrenceId || null,
      etag: (result && result.etag) ? result.etag : null,
      itipReply
    });
  } catch (err) {
    console.error('[events RSVP]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/events/:uid/history ──────────────────────────────────────────────
router.get('/:uid/history', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { calendarId } = req.query;
    if (calendarId) {
      const access = await checkCalendarAccess(req, calendarId, 'read');
      if (!access.allowed) {
        return res.status(access.status || 403).json({ error: access.reason });
      }
    }

    const history = await Db.getEventHistory(req.params.uid);
    res.json(history);
  } catch (err) {
    console.error('[events HISTORY]', err.message);
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
  return resolveUrl(baseUrl, href);
}

router.buildAbsoluteUrl = buildAbsoluteUrl;

module.exports = router;
