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

  // Non-owners are forbidden from 'owner' level actions (deleting calendar, managing shares)
  if (requiredAccess === 'owner') {
    return { allowed: false, status: 403, reason: 'Owner permission required for this action' };
  }

  // 2. Check internal calendar share table
  const userUuid = (await Db.getUserIdByUsername(userId)) || userId;
  const userShares = await Db.getSharedCalendarsForUser(userUuid);
  const matchingShare =
    userShares.find(s => s.calendar_id === calendarId) ||
    (userUuid !== userId
      ? (await Db.getSharedCalendarsForUser(userId)).find(s => s.calendar_id === calendarId)
      : null);

  if (matchingShare) {
    const canWrite = !!matchingShare.read_write;
    if (requiredAccess === 'write' && !canWrite) {
      return { allowed: false, status: 403, reason: 'Read-only calendar access: modification prohibited' };
    }
    return { allowed: true, isOwner: false, readOnly: !canWrite };
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

module.exports = {
  checkCalendarAccess
};
