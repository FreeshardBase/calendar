'use strict';

const path = require('path');
const Db = require('../db');
const { checkDelegateAccess } = require('./delegatePermissions');

/**
 * The path a calendar href really addresses on the internal Radicale (#232).
 * The request URL comes from WHATWG URL resolution against the account base
 * (host pinned, "%2e%2e" resolved), and Radicale's WSGI server then
 * percent-decodes PATH_INFO ("..%2f" becomes "../") and strips dot-segments.
 * Authorizing on anything less decoded lets "/me/%2e%2e/victim/cal/" pass as
 * the caller's own calendar while the request lands in the victim's.
 *
 * @param {string} href Relative path or absolute URL
 * @returns {string|null} Normalized absolute path, or null if not decodable
 */
function canonicalCollectionPath(href) {
  try {
    const { pathname } = new URL(href, 'http://internal-caldav.invalid/');
    return path.posix.normalize('/' + decodeURIComponent(pathname));
  } catch (e) {
    // Malformed URL or percent-encoding: callers refuse the href.
    return null;
  }
}

/**
 * Path segments of a stored share href, percent-decoded but not resolved, or
 * null if undecodable. A row keeping a dot-segment can thus never equal the
 * (normalized) segments of a request.
 *
 * @param {string} href Stored calendar href, e.g. "/owner/personal/"
 * @returns {string[]|null}
 */
function storedShareSegments(href) {
  try {
    return decodeURIComponent(href).split('/').filter(Boolean);
  } catch (e) {
    // Undecodable stored id: it can match no request.
    return null;
  }
}

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
  const hrefPath = canonicalCollectionPath(calendarHref);
  if (hrefPath === null) {
    return { allowed: false, status: 400, reason: 'Invalid calendar href' };
  }
  const segments = hrefPath.split('/').filter(Boolean);
  const ownerId = segments[0];

  if (!ownerId) {
    return { allowed: false, status: 400, reason: 'Invalid calendar href' };
  }

  // 1. Owner check. #144: the collection root is the user id itself (the OIDC sub); a display
  // name never makes anyone the owner, since it may equal another member's sub.
  if (userId === ownerId) {
    return { allowed: true, isOwner: true, ownerId };
  }

  // 2. Check internal calendar share table (sharees are stored by user id)
  const userShares = await Db.getSharedCalendarsForUser(userId);

  // Share rows are compared decoded but never resolved: a row stored under a
  // traversal id such as "/me/%2e%2e/victim/cal/" matches nothing, just as
  // the Radicale rights plugin (exact canonical id) never honors it.
  const matchingShare = userShares.find(s => {
    const parts = s.calendar_id.split('::');
    if (parts.length < 2) return false;
    const sSegs = storedShareSegments(parts.slice(1).join('::'));
    if (sSegs === null) return false;
    const sOwner = sSegs[0];
    const sSlug = sSegs.slice(1).join('/');

    const reqOwner = segments[0];
    const reqSlug = segments.slice(1).join('/');

    return sSlug === reqSlug && sOwner === reqOwner;
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
    delegateUserId: userId,
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
  const pathStr = canonicalCollectionPath(href);
  if (pathStr === null) return null;
  const parts = pathStr.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const calHref = '/' + parts.slice(0, 2).join('/') + '/';
  return `${accountId}::${calHref}`;
}

/**
 * Enqueues sync jobs after a calendar operation.
 *
 * The owner is never parsed out of the caller-supplied href on its own (#323):
 * for internal calendars only the requester's access is checked, and the
 * requester only ever gets their own sync job.
 *
 * @param {string} calendarId Format: "accountId::calendarHref"
 * @param {string} requestingUserId Requesting user ID (req.session.userId)
 */
async function queueSyncForCalendar(calendarId, requestingUserId) {
  if (!requestingUserId || requestingUserId === 'unauthenticated' || requestingUserId === 'none') {
    return;
  }
  const enqueue = (userId) => Db.addSyncJob(userId)
    .catch(err => console.error('[sync-queue] Failed to add job:', err.message));

  const sep = (calendarId || '').indexOf('::');
  if (sep === -1 || calendarId.slice(0, sep) !== 'internal-caldav') {
    // External account (or bare URL): the only party is the requester.
    await enqueue(requestingUserId);
    return;
  }

  const access = await checkCalendarAccess({ session: { userId: requestingUserId } }, calendarId, 'read');
  if (!access.allowed) {
    console.warn(`[sync-queue] Unauthorized sync queue request on ${calendarId} by user ${requestingUserId}`);
    return;
  }
  await enqueue(requestingUserId);
}

module.exports = {
  canonicalCollectionPath,
  checkCalendarAccess,
  extractCalendarIdFromHref,
  queueSyncForCalendar
};


