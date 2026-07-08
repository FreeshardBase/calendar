'use strict';

const express = require('express');
const router = express.Router();
const CalDAVClient = require('../caldav/client');
const { v4: uuidv4 } = require('uuid');

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

  if (!req.session.accounts) req.session.accounts = [];

  // Avoid duplicates by resolved URL + username
  const exists = req.session.accounts.some(
    a => a.url === discoveredUrl && a.username === username
  );
  if (exists) {
    return res.status(409).json({ error: 'Dieses Konto ist bereits eingerichtet.' });
  }

  const id = uuidv4();
  req.session.accounts.push({
    id,
    url:         discoveredUrl,
    username,
    password,
    displayName: displayName || username
  });

  res.status(201).json({ id, displayName: displayName || username, message: 'Account added.' });
});

// PATCH /api/accounts/:id — update display name
router.patch('/:id', (req, res) => {
  const account = (req.session.accounts || []).find(a => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  if (req.body.displayName) account.displayName = req.body.displayName;
  res.json({ message: 'Updated.' });
});

// DELETE /api/accounts/:id — remove account
router.delete('/:id', (req, res) => {
  if (!req.session.accounts) return res.status(404).json({ error: 'Account not found.' });

  const before = req.session.accounts.length;
  req.session.accounts = req.session.accounts.filter(a => a.id !== req.params.id);

  if (req.session.accounts.length === before) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  res.json({ message: 'Account removed.' });
});

// DELETE /api/accounts — remove all (logout)
router.delete('/', (req, res) => {
  req.session.accounts = [];
  res.json({ message: 'All accounts removed.' });
});

module.exports = router;
