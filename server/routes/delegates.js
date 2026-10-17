'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const {
  grantDelegatePermission,
  revokeDelegatePermission,
  getDelegatesForPrincipal,
  getPrincipalsForDelegate
} = require('../utils/delegatePermissions');

/**
 * GET /api/delegates
 * Returns delegates granted by current user & principals current user is delegate for
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.session.userId || process.env.CALDAV_USERNAME || 'test';
    const delegates = await getDelegatesForPrincipal(userId);
    const principals = await getPrincipalsForDelegate(userId);
    res.json({ userId, delegates, principals });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/delegates
 * Grant or update delegate permission
 */
router.post('/', async (req, res) => {
  try {
    const principalUserId = req.session.userId || process.env.CALDAV_USERNAME || 'test';
    const { delegateUserId, calendarId, role, canManageInvitations, canViewPrivate, canManageDelegates } = req.body;

    if (!delegateUserId) {
      return res.status(400).json({ error: 'delegateUserId is required' });
    }

    const permission = await grantDelegatePermission({
      principalUserId,
      delegateUserId,
      calendarId: calendarId || null,
      role: role || 'DELEGATE_WRITE',
      canManageInvitations: canManageInvitations !== undefined ? canManageInvitations : 1,
      canViewPrivate: canViewPrivate !== undefined ? canViewPrivate : 0,
      canManageDelegates: canManageDelegates !== undefined ? canManageDelegates : 0
    });

    res.json(permission);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * DELETE /api/delegates/:id
 * Revoke delegate permission
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'id parameter is required' });
    }
    const userId = req.session.userId || process.env.CALDAV_USERNAME || 'test';
    const result = await revokeDelegatePermission(id, userId);
    if (result.deleted === 0) {
      return res.status(404).json({ error: 'Delegate permission not found' });
    }
    res.json({ message: 'Delegate permission revoked', ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/delegates/principals
 * Returns list of principals current user can act on behalf of
 */
router.get('/principals', async (req, res) => {
  try {
    const userId = req.session.userId || process.env.CALDAV_USERNAME || 'test';
    const principals = await getPrincipalsForDelegate(userId);
    res.json({ userId, principals });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
