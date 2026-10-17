'use strict';

const Db = require('../db');

/**
 * Grant or update delegate permission
 */
async function grantDelegatePermission({
  principalUserId,
  delegateUserId,
  calendarId = null,
  role = 'DELEGATE_WRITE',
  canManageInvitations = 1,
  canViewPrivate = 0,
  canManageDelegates = 0
}) {
  if (!principalUserId || !delegateUserId) {
    throw new Error('principalUserId and delegateUserId are required');
  }
  return await Db.upsertDelegatePermission({
    principalUserId,
    delegateUserId,
    calendarId,
    role,
    canManageInvitations,
    canViewPrivate,
    canManageDelegates
  });
}

/**
 * Revoke a delegate permission by ID; only its principal or its delegate (userId) may revoke it.
 * Resolves { deleted: 0 } when no such grant exists for userId.
 */
async function revokeDelegatePermission(id, userId) {
  if (!id || !userId) {
    throw new Error('Permission ID and user ID required');
  }
  return await Db.deleteDelegatePermission(id, userId);
}

/**
 * Get all delegates granted by a principal
 */
async function getDelegatesForPrincipal(principalUserId) {
  if (!principalUserId) return [];
  return await Db.getDelegatesForPrincipal(principalUserId);
}

/**
 * Get all principals who granted access to a delegate
 */
async function getPrincipalsForDelegate(delegateUserId) {
  if (!delegateUserId) return [];
  return await Db.getPrincipalsForDelegate(delegateUserId);
}

/**
 * Verify whether a delegate user has permission for an action on a principal's calendar
 */
async function checkDelegateAccess({
  principalUserId,
  delegateUserId,
  calendarId = null,
  action = 'READ',
  isPrivate = false,
  isInvitation = false
}) {
  if (!principalUserId || !delegateUserId) {
    return { allowed: false, reason: 'Missing user context' };
  }

  // Same user acting on own calendar
  if (principalUserId === delegateUserId) {
    return { allowed: true, role: 'OWNER' };
  }

  const perm = await Db.getDelegatePermission(principalUserId, delegateUserId, calendarId);
  if (!perm) {
    return { allowed: false, reason: 'No delegate permission granted' };
  }

  // Check private event visibility constraint
  if (isPrivate && !perm.can_view_private) {
    return { allowed: false, reason: 'Private events access not granted to delegate' };
  }

  // Check invitation management constraint
  if (isInvitation && !perm.can_manage_invitations) {
    return { allowed: false, reason: 'Invitation management not granted to delegate' };
  }

  // Action roles evaluation
  if (action === 'WRITE' || action === 'DELETE') {
    if (perm.role !== 'DELEGATE_WRITE' && perm.role !== 'DELEGATE_ADMIN') {
      return { allowed: false, reason: 'Write access required' };
    }
  } else if (action === 'ADMIN') {
    if (perm.role !== 'DELEGATE_ADMIN' && !perm.can_manage_delegates) {
      return { allowed: false, reason: 'Admin delegate rights required' };
    }
  }

  return { allowed: true, role: perm.role, permission: perm };
}

/**
 * Appends delegate audit metadata to event payloads
 */
function decorateEventForDelegate(event, principalUserId, delegateUserId) {
  if (!event) return event;
  const isDelegated = principalUserId && delegateUserId && principalUserId !== delegateUserId;
  return {
    ...event,
    sentBy: isDelegated ? delegateUserId : (event.sentBy || principalUserId),
    onBehalfOf: isDelegated ? principalUserId : (event.onBehalfOf || null),
    xDelegateBy: isDelegated ? `DELEGATED-BY:${delegateUserId} FOR:${principalUserId}` : null
  };
}

module.exports = {
  grantDelegatePermission,
  revokeDelegatePermission,
  getDelegatesForPrincipal,
  getPrincipalsForDelegate,
  checkDelegateAccess,
  decorateEventForDelegate
};
