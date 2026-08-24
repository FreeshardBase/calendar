'use strict';

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { MSGraphSyncEngine } = require('../utils/msgraph');

// Get active user ID from request session/header
function getUserId(req) {
  return req.headers['x-test-user-id'] || (req.session && req.session.userId) || 'testuser-id';
}

/**
 * GET /api/msgraph/accounts
 * List all connected MS Graph / Office 365 accounts for active user
 */
router.get('/accounts', async (req, res) => {
  try {
    const userId = getUserId(req);
    const accounts = await Db.getMSGraphAccounts(userId);
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/msgraph/accounts
 * Connect / register new Microsoft Graph account
 */
router.post('/accounts', async (req, res) => {
  try {
    const userId = getUserId(req);
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

    res.status(201).json({ success: true, account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/msgraph/accounts/:id
 * Disconnect Microsoft Graph account
 */
router.delete('/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
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
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/msgraph/accounts/:id/sync
 * Manually trigger bidirectional MS Graph sync
 */
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
