'use strict';

const express = require('express');
const router = express.Router();
const CalDAVClient = require('../caldav/client');
const Db = require('../db');

// GET /api/accounts — list accounts (passwords redacted)
router.get('/', (req, res) => {
  const accounts = req.session.accounts || [];
  res.json(accounts.map(a => ({
    id:          a.id,
    url:         a.url,
    username:    a.username,
    displayName: a.displayName
  })));
});

// POST /api/accounts — add a new CalDAV account
router.post('/', async (req, res) => {
  const { url, username, password, displayName } = req.body;

  if (!url || !username || !password) {
    return res.status(400).json({ error: 'url, username and password are required' });
  }

  const client = new CalDAVClient({ url, username, password });

  let discoveredUrl = url;
  try {
    discoveredUrl = await client.discover();
  } catch (e) {
    const msg = e.message === 'UNAUTHORIZED'
      ? 'Ungültige Zugangsdaten.'
      : e.message === 'COULD_NOT_RESOLVE_CALDAV_ENDPOINT'
      ? 'CalDAV-Server konnte nicht automatisch ermittelt werden. Bitte prüfe die URL.'
      : `Verbindung fehlgeschlagen: ${e.message}`;
    return res.status(401).json({ error: msg });
  }

  const accounts = req.session.accounts || [];
  const exists = accounts.some(
    a => a.url === discoveredUrl && a.username === username
  );
  if (exists) {
    return res.status(409).json({ error: 'Dieses Konto ist bereits eingerichtet.' });
  }

  try {
    const userId = req.session.userId || username;
    req.session.userId = userId;
    const { id, displayName: finalDisplayName } = await Db.addAccount(userId, {
      url: discoveredUrl,
      username,
      password,
      displayName
    });
    res.status(201).json({ id, displayName: finalDisplayName, message: 'Account added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/accounts/:id — update display name
router.patch('/:id', async (req, res) => {
  if (req.params.id === 'env-default') {
    return res.status(403).json({ error: 'Systemkonto kann nicht geändert werden.' });
  }

  const account = (req.session.accounts || []).find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  try {
    if (req.body.displayName) {
      await Db.updateAccountDisplayName(req.params.id, req.body.displayName);
    }
    res.json({ message: 'Updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id — remove account
router.delete('/:id', async (req, res) => {
  if (req.params.id === 'env-default') {
    return res.status(403).json({ error: 'Systemkonto kann nicht gelöscht werden.' });
  }

  const account = (req.session.accounts || []).find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  try {
    await Db.deleteAccount(req.params.id);
    res.json({ message: 'Account removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts — remove all (logout)
router.delete('/', async (req, res) => {
  try {
    if (req.session.userId) {
      await Db.deleteUserAccounts(req.session.userId);
    }
    req.session.userId = null;
    res.json({ message: 'All accounts removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
