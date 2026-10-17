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
  updateAttendeePartstat,
  normalizeRecurrenceRule,
  resolveUrl
} = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { checkCalendarAccess, extractCalendarIdFromHref, queueSyncForCalendar } = require('../utils/calendarAuth');
const { logEventChange } = require('../utils/eventHistory');
const { sendError, describeError } = require('../utils/errorSanitizer');
const { setUnparseableHeader } = require('../utils/unparseableReport');
const { isSafeLinkUrl } = require('../../public/js/safeUrl');
const { assertValidAlarms } = require('../utils/ical');

// Issue #338: attachment URLs are rendered as links — reject non-link schemes up front.
function hasUnsafeAttachment(attachments) {
  if (!Array.isArray(attachments)) return false;
  return attachments.some(att => {
    if (!att) return false;
    const url = typeof att === 'string' ? att : att.url;
    return Boolean(url) && !isSafeLinkUrl(url);
  });
}
const UNSAFE_ATTACHMENT_ERROR = 'Unsafe attachment URL rejected: only http, https and mailto URLs are allowed';

// Issue #128: a malformed TRIGGER is rejected by the CalDAV server (or, on a
// lenient one, stored and then unreadable) — refuse it before it is serialised.
function invalidAlarmsError(alarms) {
  try {
    assertValidAlarms(alarms);
    return null;
  } catch (e) {
    return e.message;
  }
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function getUserEmailsForSession(req) {
  const emails = new Set();
  if (req.session?.userEmail && isValidEmail(req.session.userEmail)) {
    emails.add(req.session.userEmail.toLowerCase().trim());
  }
  if (req.session?.username && isValidEmail(req.session.username)) {
    emails.add(req.session.username.toLowerCase().trim());
  }
  if (req.session?.userId) {
    if (isValidEmail(req.session.userId)) {
      emails.add(req.session.userId.toLowerCase().trim());
    }
    const dbEmail = await Db.getUserEmailByUserId(req.session.userId);
    if (dbEmail && isValidEmail(dbEmail)) {
      emails.add(dbEmail.toLowerCase().trim());
    }
    const dbUsername = await Db.getUsernameByUserId(req.session.userId);
    if (dbUsername && isValidEmail(dbUsername)) {
      emails.add(dbUsername.toLowerCase().trim());
    }
  }

  return Array.from(emails);
}

// ── GET /api/events/invitations ───────────────────────────────────────────────
router.get('/invitations', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    let accounts = req.session.accounts || [];
    if (accounts.length === 0 && req.session?.userId) {
      accounts = await Db.getAccounts(req.session.userId);
    }
    const activeAccounts = accounts.filter(account => account.authType !== 'oauth2');
    const invitations = [];

    const now = new Date();
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const validEmails = await getUserEmailsForSession(req);
    const sessionIdentifiers = new Set(validEmails.map(e => e.toLowerCase()));
    if (req.session?.userId) sessionIdentifiers.add(String(req.session.userId).toLowerCase().trim());
    if (req.session?.username) sessionIdentifiers.add(String(req.session.username).toLowerCase().trim());
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
                const baseUid = ev.masterUid || (ev.uid ? ev.uid.split('::')[0] : ev.uid);
                if (!baseUid || seenUids.has(baseUid)) continue;

                if (ev.organizer) {
                  const rawOrg = typeof ev.organizer === 'string' ? ev.organizer : (ev.organizer?.email || ev.organizer?.name || '');
                  const orgEmail = rawOrg.toLowerCase().replace(/^mailto:/i, '').trim();
                  if (orgEmail && (validEmails.includes(orgEmail) || sessionIdentifiers.has(orgEmail))) continue;
                }

                if (Array.isArray(ev.attendees) && ev.attendees.length > 0) {
                  const matchedAtt = ev.attendees.find(a => {
                    const aEmail = (a.email || '').toLowerCase().replace(/^mailto:/i, '').trim();
                    return validEmails.includes(aEmail) || sessionIdentifiers.has(aEmail);
                  });
                  if (!matchedAtt) continue;

                  const status = (matchedAtt.status || matchedAtt.partstat || 'NEEDS-ACTION').toUpperCase();
                  if (status === 'ACCEPTED' || status === 'DECLINED' || status === 'DELEGATED' || status === 'TENTATIVE') continue;

                  ev.userEmail = matchedAtt.email;
                  ev.uid = baseUid;
                  seenUids.add(baseUid);
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
    return sendError(res, err, '[invitations GET]');
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
    const unparseable = [];
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
                const parseErrors = [];
                const events    = parseEventList(eventsXml, cal.id, account.id, cal.url, startDate, endDate, parseErrors);
                allEvents.push(...events);
                for (const pe of parseErrors) unparseable.push({ calendarId: cal.id, href: pe.href, error: pe.error });
                successfulCalendars++;
              } catch (eventErr) {
                console.error(`[events GET] Failed to fetch events for calendar ${cal.id}:`, eventErr.message);
                const { status, message } = describeError(eventErr);
                errors.push({ accountId: account.id, calendarId: cal.id, status, error: message });
              }
            })
          );
        } catch (accountErr) {
          console.error(`[events GET] Failed to fetch calendars for account ${account.id}:`, accountErr.message);
          const { status, message } = describeError(accountErr);
          errors.push({ accountId: account.id, status, error: message });
        }
      })
    );

    if (errors.length > 0) {
      res.setHeader('X-CalDAV-Error', JSON.stringify(errors.map(e => e.error)));
    }
    setUnparseableHeader(res, unparseable);

    const specificCalendarFailed = calendarId && errors.some(e => e.calendarId === calendarId);
    const allAccountsFailed = activeAccounts.length > 0 && errors.length >= activeAccounts.length && successfulCalendars === 0;

    if (specificCalendarFailed || allAccountsFailed) {
      // The client prefixes "Fehler beim Laden der Termine: "; send the cause
      // under its mapped status (an upstream 403 stays a 403).
      const failure = errors.find(e => calendarId && e.calendarId === calendarId) || errors[0];
      return res.status(failure.status).json({ error: failure.error, errors });
    }

    let filteredEvents = allEvents;
    if (req.query.category || req.query.tag) {
      const target = String(req.query.category || req.query.tag).trim().toLowerCase();
      filteredEvents = filteredEvents.filter(ev =>
        Array.isArray(ev.categories) && ev.categories.some(c => String(c).trim().toLowerCase() === target)
      );
    }

    // A calendar or account that could not be read is named in `errors` even
    // when others succeeded, so a partial failure never looks like a free week (#65).
    res.json({ events: filteredEvents, errors });
  } catch (err) {
    return sendError(res, err, '[events GET]');
  }
});

// ── POST /api/events — create a new event ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { calendarId, ...eventData } = req.body;

    if (!calendarId) {
      return res.status(400).json({ error: 'calendarId is required' });
    }
    if (hasUnsafeAttachment(eventData.attachments)) {
      return res.status(400).json({ error: UNSAFE_ATTACHMENT_ERROR });
    }
    const alarmError = invalidAlarmsError(eventData.alarms);
    if (alarmError) return res.status(400).json({ error: alarmError });

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const uid = uuidv4();
    const event = { ...eventData, uid };
    if (event.recurrence && event.start) {
      event.recurrence = normalizeRecurrenceRule(event.recurrence, event.start, event.allDay ? null : event.startTimeZone);
    }
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
    return sendError(res, err, '[events POST]');
  }
});

// ── PUT /api/events/:uid — update an existing event ───────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    const { calendarId, sourceCalendarId, etag, href, scope, recurrenceId, ...eventData } = req.body;

    if (!href)       return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });
    if (hasUnsafeAttachment(eventData.attachments)) {
      return res.status(400).json({ error: UNSAFE_ATTACHMENT_ERROR });
    }
    const alarmError = invalidAlarmsError(eventData.alarms);
    if (alarmError) return res.status(400).json({ error: alarmError });

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const targetRecurrenceId = recurrenceId || eventData.recurrenceId || (req.params.uid && req.params.uid.includes('::') ? req.params.uid.split('::')[1] : null) || (req.body.uid && req.body.uid.includes('::') ? req.body.uid.split('::')[1] : null);

    // The event is stored in `sourceCalendarId` and was given another calendar in the dialog (#494).
    if (sourceCalendarId && sourceCalendarId !== calendarId) {
      return await moveEvent(req, res, { calendarId, sourceCalendarId, href, scope, eventData, targetRecurrenceId });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    // An href that names no calendar (undecodable, or above calendar level)
    // cannot be authorized, so it is refused rather than left unchecked (#232).
    if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
    if (derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const masterUid = req.params.uid.split('::')[0];
    const event     = { ...eventData, uid: masterUid };
    if (targetRecurrenceId) {
      event.recurrenceId = targetRecurrenceId;
    }
    // BYDAY is re-derived by updateWholeSeries against the stored master; doing
    // it here against the clicked occurrence would rewrite off-pattern rules (#238).
    const eventUrl  = buildAbsoluteUrl(account.url, href);

    let ics;
    let ifMatch;
    let existingIcs = null;
    if (scope === 'occurrence' && targetRecurrenceId) {
      // Edit a single occurrence: write a detached exception VEVENT into the
      // existing resource instead of replacing the whole series.
      const current = await client.get(eventUrl);
      existingIcs = current ? current.ics : null;
      if (current && current.ics && isNoOpEventSave(current.ics, eventData, targetRecurrenceId)) {
        queueSyncForCalendar(calendarId, req.session.userId);
        return res.json({
          ...event,
          href,
          etag: (current && current.etag) ? current.etag : etag,
          calendarId
        });
      }
      ics     = upsertOccurrenceOverride(current.ics, targetRecurrenceId, eventData);
      ifMatch = current.etag;
    } else {
      let current = null;
      try {
        current = await client.get(eventUrl);
      } catch (err) {
        // A new resource has nothing to merge with; any other failure must not become an overwrite (#343).
        if (!/^GET (404|410):/.test(err.message)) throw err;
      }
      existingIcs = current ? current.ics : null;

      if (current && current.ics && isNoOpEventSave(current.ics, event, targetRecurrenceId)) {
        queueSyncForCalendar(calendarId, req.session.userId);
        const { recurrenceId: _ignored, ...cleanMasterEvent } = event;
        if (scope === 'series') {
          const parsed = parseICSToEvent(current.ics);
          if (parsed && parsed.start) {
            cleanMasterEvent.start = parsed.start;
            cleanMasterEvent.end = parsed.end;
          }
        }
        return res.json({
          ...(scope === 'series' ? cleanMasterEvent : event),
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
    let responseEvent = event;
    if (scope === 'series') {
      const { recurrenceId: _ignored, ...cleanMasterEvent } = event;
      if (ics) {
        const parsed = parseICSToEvent(ics);
        if (parsed && parsed.start) {
          cleanMasterEvent.start = parsed.start;
          cleanMasterEvent.end = parsed.end;
        }
      }
      responseEvent = cleanMasterEvent;
    }
    await logEventChange({
      eventUid: masterUid,
      calendarId,
      userId: req.session.userId,
      action: 'UPDATE',
      oldEvent,
      newEvent: responseEvent,
      snapshotIcs: ics
    }).catch(err => console.error('[events PUT history]', err.message));

    res.json({
      ...responseEvent,
      href,
      etag:       (result && result.etag) ? result.etag : etag,
      calendarId
    });
  } catch (err) {
    return sendError(res, err, '[events PUT]');
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
    // An href that names no calendar (undecodable, or above calendar level)
    // cannot be authorized, so it is refused rather than left unchecked (#232).
    if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
    // The calendar the href points into is the one whose event is deleted.
    let targetAccess = access;
    if (derivedCalId !== calendarId) {
      targetAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!targetAccess.allowed) {
        return res.status(targetAccess.status || 403).json({ error: targetAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const eventUrl = buildAbsoluteUrl(account.url, href);
    const targetRecurrenceId = recurrenceId || (req.params.uid && req.params.uid.includes('::') ? req.params.uid.split('::')[1] : null);

    if (scope === 'occurrence' && targetRecurrenceId) {
      // Delete a single occurrence: EXDATE it in the master instead of
      // deleting the whole series resource.
      const current = await client.get(eventUrl);
      const ics = addOccurrenceException(current.ics, targetRecurrenceId);
      await client.put(eventUrl, ics, current.etag);
      queueSyncForCalendar(calendarId, req.session.userId);
      return res.json({ message: 'Occurrence deleted.' });
    }

    if (!targetAccess.isOwner && extractCalendarIdFromHref(accountId, new URL(eventUrl).pathname) !== derivedCalId) {
      return res.status(400).json({ error: 'Invalid href' });
    }

    await deleteStoredEvent(req, client, eventUrl, etag, { uid: req.params.uid, derivedCalId, access: targetAccess });

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
    return sendError(res, err, '[events DELETE]');
  }
});

// ── POST /api/events/:uid/rsvp ────────────────────────────────────────────────
router.post('/:uid/rsvp', async (req, res) => {
  try {
    const { calendarId, href, email, status, recurrenceId } = req.body;

    if (!href || !calendarId || !status) {
      return res.status(400).json({ error: 'calendarId, href, and status are required' });
    }

    const validStatuses = ['ACCEPTED', 'DECLINED', 'TENTATIVE'];
    const normStatus = String(status).toUpperCase();
    if (!validStatuses.includes(normStatus)) {
      return res.status(400).json({ error: 'Invalid status: must be ACCEPTED, DECLINED, or TENTATIVE' });
    }

    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    // An href that names no calendar (undecodable, or above calendar level)
    // cannot be authorized, so it is refused rather than left unchecked (#232).
    if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
    if (derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'read');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const eventUrl = buildAbsoluteUrl(account.url, href);
    const current = await client.get(eventUrl);
    if (!current || !current.ics) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Issue #67 & #77: Validate user email against session identity and event attendees
    const parsedCurrent = parseICSToEvent(current.ics);
    const attendees = parsedCurrent?.attendees || [];
    const validEmails = await getUserEmailsForSession(req);

    if (validEmails.length === 0) {
      return res.status(403).json({ error: 'No verified user email found in session to perform RSVP' });
    }

    let rsvpEmail = (email || '').toLowerCase().replace(/^mailto:/i, '').trim();

    if (rsvpEmail) {
      const isUserEmail = validEmails.includes(rsvpEmail);
      if (!isUserEmail) {
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

    const updatedIcs = updateAttendeePartstat(current.ics, rsvpEmail, normStatus, recurrenceId);
    const result = await client.put(eventUrl, updatedIcs, current.etag);

    const parsedEv = parseICSToEvent(updatedIcs, { recurrenceId });
    const eventForReply = { ...(parsedEv || { uid: req.params.uid, title: 'Event' }), recurrenceId: recurrenceId || parsedEv?.recurrenceId };
    const itipReply = buildItipReply(eventForReply, rsvpEmail, normStatus);

    queueSyncForCalendar(calendarId, req.session.userId);

    await logEventChange({
      eventUid: req.params.uid,
      calendarId,
      userId: req.session.userId,
      action: 'RSVP',
      newEvent: { status: normStatus, recurrenceId }
    }).catch(err => console.error('[events RSVP history]', err.message));

    res.json({
      success: true,
      status: normStatus,
      recurrenceId: recurrenceId || null,
      etag: (result && result.etag) ? result.etag : null,
      itipReply
    });
  } catch (err) {
    return sendError(res, err, '[events RSVP]');
  }
});

// ── GET /api/events/:uid/history ──────────────────────────────────────────────
router.get('/:uid/history', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // #527: event UIDs are not secret, so the history is served only for a calendar the caller may
    // read, and only the rows recorded for that calendar.
    const calendarId = typeof req.query.calendarId === 'string' ? req.query.calendarId : '';
    const access = await checkCalendarAccess(req, calendarId, 'read');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const history = await Db.getEventHistoryInCalendar(req.params.uid, calendarId);
    res.json(history);
  } catch (err) {
    return sendError(res, err, '[events HISTORY]');
  }
});


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Delete a stored event resource.
 *
 * A sharee deleting the owner's event: the record lets the sync worker put it back into
 * Radicale before the owner's next sync, which would otherwise carry the delete out into the
 * owner's external calendar (#319). It is written first, so a failure aborts the delete instead
 * of losing the protection (#343). If the delete itself then fails, the record is withdrawn
 * again, so the worker never writes over an event that was not deleted.
 * Only owner ids with a linked external account get a record: the owner's sync jobs run
 * under those ids, and without such an account nothing can carry the delete out of the shard.
 *
 * With `strictEtag` a changed resource (412) is not deleted; the plain DELETE route retries
 * without the precondition instead.
 */
async function deleteStoredEvent(req, client, eventUrl, etag, { uid, derivedCalId, access, strictEtag = false }) {
  const ifMatch = etag ? formatIfMatch(etag) : null;
  const crossUserDeletions = [];
  if (!access.isOwner) {
    const eventPath = new URL(eventUrl).pathname;
    const ownerSegment = derivedCalId.split('::')[1].split('/').filter(Boolean)[0];
    // #144: the owner segment is the owner's user id.
    if (await Db.hasExternalAccounts(ownerSegment)) {
      const stored = await client.get(eventUrl);
      crossUserDeletions.push(await Db.recordCrossUserDeletion(
        uid, derivedCalId, ownerSegment, req.session.userId, eventPath, stored.ics));
    }
  }

  try {
    try {
      await client.delete(eventUrl, ifMatch);
    } catch (delErr) {
      if (delErr.message === 'ETAG_CONFLICT' && !strictEtag) {
        await client.delete(eventUrl, null);
      } else {
        throw delErr;
      }
    }
  } catch (delErr) {
    for (const record of crossUserDeletions) await Db.clearCrossUserDeletion(record.id);
    throw delErr;
  }
}

/**
 * Move an event (a series with all its exceptions) into another calendar (#494).
 *
 * The edited event is first created in the target collection under the same UID, and only then
 * deleted from the source, so a failure never loses it. If the source cannot be deleted (gone,
 * changed meanwhile, refused), the new copy is removed again and the move fails as a whole.
 */
async function moveEvent(req, res, { calendarId, sourceCalendarId, href, scope, eventData, targetRecurrenceId }) {
  if (scope === 'occurrence') {
    return res.status(400).json({ error: 'A single occurrence cannot be moved to another calendar; move the whole series' });
  }

  const sourceAccess = await checkCalendarAccess(req, sourceCalendarId, 'write');
  if (!sourceAccess.allowed) {
    return res.status(sourceAccess.status || 403).json({ error: sourceAccess.reason });
  }
  const sourceAccountId = sourceCalendarId.split('::')[0];
  const derivedCalId = extractCalendarIdFromHref(sourceAccountId, href);
  if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
  let hrefAccess = sourceAccess;
  if (derivedCalId !== sourceCalendarId) {
    hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
    if (!hrefAccess.allowed) {
      return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
    }
  }

  const source = await resolveAccount(req, sourceCalendarId);
  const target = await resolveAccount(req, calendarId);
  if (!source.account || !target.account) return res.status(404).json({ error: 'Account not found' });

  const sourceUrl = buildAbsoluteUrl(source.account.url, href);
  if (!hrefAccess.isOwner && extractCalendarIdFromHref(sourceAccountId, new URL(sourceUrl).pathname) !== derivedCalId) {
    return res.status(400).json({ error: 'Invalid href' });
  }

  const masterUid = req.params.uid.split('::')[0];
  const event = { ...eventData, uid: masterUid };
  if (targetRecurrenceId) event.recurrenceId = targetRecurrenceId;

  const current = await source.client.get(sourceUrl);
  const ics = updateWholeSeries(current.ics, event);

  const targetHref = calendarId.split('::').slice(1).join('::');
  const targetUrl = buildAbsoluteUrl(target.account.url, targetHref).replace(/\/+$/, '') + '/' + encodeURIComponent(masterUid) + '.ics';

  let created;
  try {
    created = await target.client.put(targetUrl, ics, null);
  } catch (putErr) {
    if (putErr.message === 'ETAG_CONFLICT') {
      return res.status(409).json({ error: 'The target calendar already holds an event with this UID' });
    }
    throw putErr;
  }

  try {
    await deleteStoredEvent(req, source.client, sourceUrl, current.etag,
      { uid: masterUid, derivedCalId, access: hrefAccess, strictEtag: true });
  } catch (delErr) {
    try {
      await target.client.delete(targetUrl, created.etag);
    } catch (rollbackErr) {
      console.error('[events move] Removing the copy in the target calendar failed:', rollbackErr.message);
      throw new Error(`Move failed and the copy in the target calendar could not be removed again: ${delErr.message}`);
    }
    if (delErr.message === 'ETAG_CONFLICT') {
      return res.status(409).json({ error: 'The event was changed meanwhile; it was not moved' });
    }
    throw delErr;
  }

  queueSyncForCalendar(sourceCalendarId, req.session.userId);
  queueSyncForCalendar(calendarId, req.session.userId);

  let responseEvent = event;
  if (targetRecurrenceId) {
    const { recurrenceId: _ignored, ...cleanMasterEvent } = event;
    const parsed = parseICSToEvent(ics);
    if (parsed && parsed.start) {
      cleanMasterEvent.start = parsed.start;
      cleanMasterEvent.end = parsed.end;
    }
    responseEvent = cleanMasterEvent;
  }
  await logEventChange({
    eventUid: masterUid,
    calendarId,
    userId: req.session.userId,
    action: 'UPDATE',
    oldEvent: parseICSToEvent(current.ics),
    newEvent: responseEvent,
    snapshotIcs: ics
  }).catch(err => console.error('[events move history]', err.message));

  return res.json({
    ...responseEvent,
    href: targetUrl,
    etag: created.etag || null,
    calendarId
  });
}

async function resolveAccount(req, calendarId) {
  const accountId = calendarId.split('::')[0];
  let account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account && req.session?.userId) {
    const dbAccounts = await Db.getAccounts(req.session.userId);
    account = dbAccounts.find(a => a.id === accountId);
  }
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
