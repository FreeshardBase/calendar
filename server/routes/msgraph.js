'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { MSGraphSyncEngine } = require('../utils/msgraph');

// Get active user ID from request session/header
function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  return null;
}

/**
 * GET /api/msgraph/accounts
 * List all connected MS Graph / Office 365 accounts for active user (sensitive tokens redacted)
 */
router.get('/accounts', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const accounts = await Db.getMSGraphAccounts(userId);
    const sanitized = accounts.map(({ accessToken, refreshToken, ...rest }) => rest);
    res.json({ success: true, accounts: sanitized });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/msgraph/accounts
 * Connect / register new Microsoft Graph account
 */
router.post('/accounts', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { accountEmail, tenantId, clientId, accessToken, refreshToken, targetCalendarId } = req.body;

    if (!accountEmail) {
      return res.status(400).json({ error: 'accountEmail ist ein Pflichtfeld' });
    }

    const account = await Db.addMSGraphAccount({
      userId,
      tenantId: tenantId || 'common',
      clientId: clientId || '',
      accountEmail,
      accessToken: accessToken || `mock-access-token-${Date.now()}`,
      refreshToken: refreshToken || `mock-refresh-token-${Date.now()}`,
      expiresAt: Date.now() + 3600000,
      targetCalendarId: targetCalendarId || ''
    });

    await Db.addSyncJob(userId);

    const { accessToken: _, refreshToken: __, ...sanitizedAccount } = account;
    res.status(201).json({ success: true, account: sanitizedAccount });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * DELETE /api/msgraph/accounts/:id
 * Disconnect Microsoft Graph account
 */
router.delete('/accounts/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { id } = req.params;
    const account = await Db.getMSGraphAccountById(id);
    if (!account) {
      return res.status(404).json({ error: 'MS Graph Konto nicht gefunden' });
    }
    if (account.userId !== userId) {
      return res.status(403).json({ error: 'Zugriff verweigert: MS Graph Konto gehört einem anderen Benutzer' });
    }
    await Db.deleteMSGraphAccount(id);
    res.json({ success: true, message: 'MS Graph Konto erfolgreich entfernt' });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * POST /api/msgraph/accounts/:id/sync
 * Manually trigger bidirectional MS Graph sync
 */
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { id } = req.params;
    const account = await Db.getMSGraphAccountById(id);
    if (!account) {
      return res.status(404).json({ error: 'MS Graph Konto nicht gefunden' });
    }
    if (account.userId !== userId) {
      return res.status(403).json({ error: 'Zugriff verweigert: MS Graph Konto gehört einem anderen Benutzer' });
    }

    await Db.addSyncJob(userId);

    const engine = new MSGraphSyncEngine(account);
    const localEvents = req.body.localEvents || [];
    const syncResult = await engine.sync(localEvents);

    res.json({ success: true, syncResult });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
