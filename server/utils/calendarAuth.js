'use strict';

const Db = require('../db');
const { checkDelegateAccess } = require('./delegatePermissions');

/**
 * Check whether the requesting user in `req` has permission to perform `requiredAccess`
 * on the calendar specified by `calendarId`.
 *
 * @param {Object} req Express request object (contains req.session)
 * @param {string} calendarId Format: "accountId::calendarHref"
 * @param {'read' | 'write' | 'owner'} requiredAccess
 * @returns {Promise<{ allowed: boolean, status?: number, reason?: string, isOwner?: boolean }>}
 */
async function checkCalendarAccess(req, calendarId, requiredAccess = 'read') {
  const userId = req.session?.userId;
  if (!userId) {
    return { allowed: false, status: 401, reason: 'Authentication required' };
  }

  if (!calendarId) {
    return { allowed: false, status: 400, reason: 'calendarId is required' };
  }

  const sep = calendarId.indexOf('::');
  if (sep === -1) {
    return { allowed: false, status: 400, reason: 'Invalid calendarId format' };
  }

  const accountId = calendarId.slice(0, sep);
  const calendarHref = calendarId.slice(sep + 2);

  // Non-internal accounts belong exclusively to the logged-in session user
  if (accountId !== 'internal-caldav') {
    const account = (req.session.accounts || []).find(a => a.id === accountId);
    if (!account) {
      return { allowed: false, status: 404, reason: 'Account not found' };
    }
    return { allowed: true, isOwner: true };
  }

  // Internal CalDAV calendars: /ownerId/calendarSlug/
  let hrefPath = calendarHref;
  if (/^https?:\/\//i.test(calendarHref)) {
    try {
      hrefPath = new URL(calendarHref).pathname;
    } catch (e) {}
  }
  const pathPosix = require('path').posix;
  hrefPath = pathPosix.normalize('/' + hrefPath);
  const segments = hrefPath.split('/').filter(Boolean);
  const ownerId = segments[0];

  if (!ownerId) {
    return { allowed: false, status: 400, reason: 'Invalid calendar href' };
  }

  // 1. Direct or Mapped Owner check
  let isOwner = (userId === ownerId);
  if (!isOwner) {
    const mappedUser = await Db.getUserIdByUsername(userId);
    const mappedOwner = await Db.getUserIdByUsername(ownerId);
    if (
      (mappedUser && mappedUser === ownerId) ||
      (mappedOwner && mappedOwner === userId) ||
      (mappedUser && mappedOwner && mappedUser === mappedOwner)
    ) {
      isOwner = true;
    }
  }

  if (isOwner) {
    return { allowed: true, isOwner: true };
  }

  // 2. Check internal calendar share table
  const userUuid = (await Db.getUserIdByUsername(userId)) || userId;
  const username = (await Db.getUsernameByUserId(userId)) || userId;
  
  const sharesSet = new Map();
  for (const uid of [userId, userUuid, username]) {
    if (!uid) continue;
    const shares = await Db.getSharedCalendarsForUser(uid);
    for (const s of shares) {
      sharesSet.set(s.calendar_id, s);
    }
  }
  const userShares = Array.from(sharesSet.values());

  const ownerUuid = (await Db.getUserIdByUsername(ownerId)) || ownerId;
  const ownerUsername = (await Db.getUsernameByUserId(ownerId)) || ownerId;

  const matchingShare = userShares.find(s => {
    if (s.calendar_id === calendarId) return true;
    const parts = s.calendar_id.split('::');
    if (parts.length < 2) return false;
    const sHref = parts[1];
    const sSegs = sHref.split('/').filter(Boolean);
    const sOwner = sSegs[0];
    const sSlug = sSegs.slice(1).join('/');

    const reqParts = calendarId.split('::');
    const reqHref = reqParts[1] || '';
    const reqSegs = reqHref.split('/').filter(Boolean);
    const reqOwner = reqSegs[0];
    const reqSlug = reqSegs.slice(1).join('/');

    const slugMatches = (sSlug === reqSlug);
    // The share's owner must be the requested owner (under any of its ids).
    // reqOwner is always one of ownerUuid/ownerUsername, so comparing those to
    // each other would match a same-slug calendar of any other user.
    const ownerMatches = (
      sOwner === reqOwner ||
      sOwner === ownerUuid ||
      sOwner === ownerUsername
    );
    return slugMatches && ownerMatches;
  });

  if (matchingShare) {
    const role = matchingShare.role || (matchingShare.read_write ? 'WRITE' : 'READ');
    const canManageShares = !!matchingShare.can_manage_shares || role === 'ADMIN';
    const canViewPrivate = !!matchingShare.can_view_private || role === 'ADMIN';
    const canWrite = role === 'WRITE' || role === 'ADMIN' || (!!matchingShare.read_write && role !== 'READ' && role !== 'FREE_BUSY');

    if (requiredAccess === 'owner') {
      if (canManageShares) {
        return { allowed: true, isOwner: false, canManageShares: true, role, canViewPrivate };
      }
      return { allowed: false, status: 403, reason: 'Owner permission required for this action' };
    }

    if (requiredAccess === 'write' && !canWrite) {
      return { allowed: false, status: 403, reason: 'Read-only calendar access: modification prohibited' };
    }

    return { allowed: true, isOwner: false, readOnly: !canWrite, role, canViewPrivate, canManageShares };
  }

  // Non-owners without matching share are forbidden from 'owner' level actions
  if (requiredAccess === 'owner') {
    return { allowed: false, status: 403, reason: 'Owner permission required for this action' };
  }

  // 3. Check delegate permissions
  const actionName = requiredAccess === 'write' ? 'WRITE' : 'READ';
  const delegateRes = await checkDelegateAccess({
    principalUserId: ownerId,
    delegateUserId: userUuid,
    calendarId,
    action: actionName
  });

  if (delegateRes.allowed) {
    return { allowed: true, isOwner: false, isDelegate: true };
  }

  return { allowed: false, status: 403, reason: 'Access denied: You do not have permission for this calendar' };
}

/**
 * Extract the calendar ID from an account ID and resource href string.
 *
 * @param {string} accountId E.g., "internal-caldav"
 * @param {string} href E.g., "/user/personal/event.ics" or "https://domain/user/personal/event.ics"
 * @returns {string|null} Format: "accountId::/user/personal/" or null
 */
function extractCalendarIdFromHref(accountId, href) {
  if (!accountId || !href) return null;
  let pathStr = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      pathStr = new URL(href).pathname;
    } catch (e) {}
  }
  const pathPosix = require('path').posix;
  pathStr = pathPosix.normalize('/' + pathStr);
  const parts = pathStr.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const calHref = '/' + parts.slice(0, 2).join('/') + '/';
  return `${accountId}::${calHref}`;
}

/**
 * Safely enqueues sync jobs for calendar operations after verifying request owner authorization.
 *
 * @param {string} calendarId Format: "accountId::calendarHref"
 * @param {string} fallbackUserId Requesting user ID
 */
async function queueSyncForCalendar(calendarId, fallbackUserId) {
  if (!fallbackUserId || fallbackUserId === 'unauthenticated' || fallbackUserId === 'none') {
    return;
  }
  try {
    const parts = (calendarId || '').split('::');
    const calendarHref = parts[1] || parts[0];
    if (calendarHref) {
      const pathPosix = require('path').posix;
      const normalizedHref = pathPosix.normalize('/' + calendarHref);
      const segments = normalizedHref.split('/').filter(Boolean);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ownerUserId = segments.find(s => uuidRegex.test(s));
      if (ownerUserId) {
        if (fallbackUserId === ownerUserId) {
          await Db.addSyncJob(ownerUserId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
          return;
        }
        // Verify authorization of fallbackUserId on calendarId before enqueuing owner sync job
        const mockReq = { session: { userId: fallbackUserId } };
        const access = await checkCalendarAccess(mockReq, calendarId, 'read');
        if (access && access.allowed) {
          if (access.isOwner) {
            await Db.addSyncJob(ownerUserId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
          }
          await Db.addSyncJob(fallbackUserId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
        } else {
          console.warn(`[sync-queue] Unauthorized sync queue request on ${calendarId} by user ${fallbackUserId}`);
        }
        return;
      }
    }
  } catch (e) {
    console.error('[sync] Error parsing calendar owner for sync:', e.message);
  }
  if (fallbackUserId) {
    await Db.addSyncJob(fallbackUserId).catch(err => console.error('[sync-queue] Failed to add job:', err.message));
  }
}

module.exports = {
  checkCalendarAccess,
  extractCalendarIdFromHref,
  queueSyncForCalendar
};


