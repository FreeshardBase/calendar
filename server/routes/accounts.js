'use strict';

const express = require('express');
const router = express.Router();
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { getPresets, resolvePreset, resolveCalDAVUrl } = require('../utils/caldavPresets');

// GET /api/accounts/presets — get available provider presets and resolve query parameters
router.get('/presets', (req, res) => {
  const emailOrPreset = req.query.email || req.query.preset || req.query.username;
  const resolved = emailOrPreset ? resolvePreset(emailOrPreset) : null;
  res.json({
    presets: getPresets(),
    resolved
  });
});

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
  let { url, username, password, displayName } = req.body;

  const targetUrl = resolveCalDAVUrl(url || username);

  if (!targetUrl || !username || !password) {
    return res.status(400).json({ error: 'url, username and password are required' });
  }

  const client = new CalDAVClient({ url: targetUrl, username, password });

  let discoveredUrl = targetUrl;
  try {
    discoveredUrl = await client.discover();
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });
    }
    if (e.message === 'COULD_NOT_RESOLVE_CALDAV_ENDPOINT') {
      return res.status(400).json({ error: 'CalDAV-Server konnte nicht automatisch ermittelt werden. Bitte prüfe die URL.' });
    }
    return res.status(502).json({ error: 'Verbindung fehlgeschlagen. Bitte prüfe URL und Netzwerkverbindung.' });
  }

  // Issue #157: verify credentials against the discovered calendar home.
  // Discovery can succeed unauthenticated on many servers (e.g. /.well-known/caldav
  // redirects without auth). A wrong password would be stored and surface later as an
  // empty calendar. testConnection() issues a PROPFIND with credentials to confirm.
  try {
    await client.testConnection();
  } catch (e) {
    return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });
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
    await Db.addSyncJob(userId).catch(err => console.error('[sync-queue] Failed to add sync job after account creation:', err.message));
    res.status(201).json({ id, displayName: finalDisplayName, message: 'Account added.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/sync — trigger background sync for linked CalDAV account
router.post('/:id/sync', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }

  try {
    const account = await Db.getAccountById(req.params.id);
    if (!account || account.userId !== req.session.userId) {
      return res.status(404).json({ error: 'Konto nicht gefunden.' });
    }

    const job = await Db.addSyncJob(req.session.userId);
    res.json({ message: 'Synchronisation gestartet.', jobId: job.id, accountId: account.id });
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

  // Primary path: account is present in session (normal case).
  let account = (req.session.accounts || []).find(a => a.id === req.params.id);

  // Issue #136 fallback: the account may have been dropped from req.session.accounts
  // by the per-row decrypt guard in Db.getAccounts() (undecryptable ciphertext / key
  // mismatch).  Fall back to a raw ownership lookup (no decryption) so the user can
  // still remove the broken row from the UI.
  if (!account) {
    try {
      const owner = await Db.getAccountOwner(req.params.id);
      if (owner && owner.userId === req.session.userId) {
        account = owner; // minimal object — only id/userId needed to authorise the DELETE
      }
    } catch (err) {
      console.error('[accounts] getAccountOwner failed during DELETE fallback:', err.message);
    }
  }

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

// GET /api/accounts/oauth-token-status — per-account OAuth token expiry state
// Returns only oauth2 accounts; never exposes credentials.
router.get('/oauth-token-status', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    const accounts = await Db.getOAuthTokenStatus(req.session.userId);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── App-Specific Passwords (ASPs) API ───────────────────────────────────────

// GET /api/accounts/app-passwords — list ASPs
router.get('/app-passwords', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    const list = await Db.getAppPasswords(req.session.userId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/app-passwords — create new ASP
router.post('/app-passwords', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  const { label } = req.body;
  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'Bezeichnung ist erforderlich.' });
  }

  try {
    const result = await Db.addAppPassword(req.session.userId, label.trim());
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/app-passwords/:id — delete ASP
router.delete('/app-passwords/:id', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    await Db.deleteAppPassword(req.params.id);
    res.json({ message: 'Passwort entfernt.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
