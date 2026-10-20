'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { getPresets, resolvePreset, resolveCalDAVUrl } = require('../utils/caldavPresets');
const { assertPublicUrl } = require('../utils/outboundFetch');
const { sameAccountUrl } = require('../utils/accountUrl');

const BLOCKED_TARGET_ERROR = 'Diese Adresse ist nicht erlaubt: interne oder private Netzwerkziele können nicht verknüpft werden.';

// Issue #334: url and username end up in the sync-worker's vdirsyncer config.
// Control characters (newlines in particular) are never legitimate there.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// GET /api/accounts/presets — get available provider presets and resolve query parameters
router.get('/presets', (req, res) => {
  const emailOrPreset = req.query.email || req.query.preset || req.query.username;
  const resolved = emailOrPreset ? resolvePreset(emailOrPreset) : null;
  res.json({
    presets: getPresets(),
    resolved
  });
});

// #614: GET /api/accounts/reattach-offers — calendars kept from a disconnected account that the
// same account, linked again, can take back instead of mirroring them a second time.
router.get('/reattach-offers', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    res.json(await Db.getReattachOffers(req.session.userId));
  } catch (err) {
    return sendError(res, err);
  }
});

// #614: POST /api/accounts/reattach-offers { accept } — re-attach the offered calendars (the sync
// resumes in them) or keep them as they are (the account gets new mirrors).
router.post('/reattach-offers', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  if (typeof req.body?.accept !== 'boolean') {
    return res.status(400).json({ error: 'accept muss true oder false sein.' });
  }
  try {
    const resolved = await Db.resolveReattachOffers(req.session.userId, req.body.accept);
    if (resolved) await Db.addSyncJob(req.session.userId);
    res.json({ resolved });
  } catch (err) {
    return sendError(res, err);
  }
});

// #614: POST /api/accounts/mirrors/:collection/disconnect — stop syncing one mirrored calendar; it
// stays as a normal calendar, nothing is deleted at the provider.
router.post('/mirrors/:collection/disconnect', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    if (!(await Db.detachCalendar(req.session.userId, req.params.collection))) {
      return res.status(404).json({ error: 'Kein verknüpfter Kalender.' });
    }
    res.json({ message: 'Verbindung getrennt.' });
  } catch (err) {
    return sendError(res, err);
  }
});

// GET /api/accounts — list accounts (passwords redacted)
router.get('/', async (req, res) => {
  if (req.accountLoadError) {
    // The cause is logged where it happened (server/index.js); it stays out of the response.
    return res.status(500).json({ error: 'Fehler beim Laden der Kontodaten.' });
  }
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Issue #136: accounts whose credentials cannot be decrypted are not in the
  // session (no CalDAV consumer may use them), but they must be listed so the
  // user can see and delete them from the UI.
  let unreadable;
  try {
    unreadable = await Db.getUnreadableAccounts(req.session.userId);
  } catch (err) {
    console.error('[accounts GET] Failed to load unreadable accounts:', err.message);
    return res.status(500).json({ error: 'Fehler beim Laden der Kontodaten.' });
  }
  const accounts = req.session?.accounts || [];
  res.json([
    ...accounts.map(a => ({
      id:          a.id,
      url:         a.url,
      username:    a.username,
      displayName: a.displayName
    })),
    ...unreadable.map(a => ({
      id:                    a.id,
      url:                   a.url,
      username:              a.username,
      displayName:           a.displayName,
      credentialsUnreadable: true
    }))
  ]);
});

// POST /api/accounts — add a new CalDAV account
router.post('/', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let { url, username, password, displayName } = req.body;

  const targetUrl = resolveCalDAVUrl(url || username);

  if (!targetUrl || !username || !password) {
    return res.status(400).json({ error: 'url, username and password are required' });
  }
  if (typeof username !== 'string' || CONTROL_CHARS.test(username)) {
    return res.status(400).json({ error: 'Ungültiger Benutzername.' });
  }
  if (!isSafeHttpUrl(targetUrl)) {
    return res.status(400).json({ error: 'Ungültige URL: nur http(s) ohne Steuerzeichen erlaubt.' });
  }

  // Issue #337: no server-side probe of internal/private targets (SSRF, port scan).
  try {
    await assertPublicUrl(targetUrl);
  } catch (e) {
    if (e.code === 'OUTBOUND_URL_BLOCKED') {
      return res.status(400).json({ error: BLOCKED_TARGET_ERROR });
    }
    return res.status(502).json({ error: 'Verbindung fehlgeschlagen. Bitte prüfe URL und Netzwerkverbindung.' });
  }

  const client = new CalDAVClient({ url: targetUrl, username, password, guardOutbound: true });

  let discoveredUrl = targetUrl;
  try {
    discoveredUrl = await client.discover();
  } catch (e) {
    if (e.code === 'OUTBOUND_URL_BLOCKED') {
      return res.status(400).json({ error: BLOCKED_TARGET_ERROR });
    }
    if (e.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });
    }
    if (e.message === 'COULD_NOT_RESOLVE_CALDAV_ENDPOINT') {
      return res.status(400).json({ error: 'CalDAV-Server konnte nicht automatisch ermittelt werden. Bitte prüfe die URL.' });
    }
    return res.status(502).json({ error: 'Verbindung fehlgeschlagen. Bitte prüfe URL und Netzwerkverbindung.' });
  }
  if (!isSafeHttpUrl(discoveredUrl)) {
    return res.status(400).json({ error: 'Der Server lieferte eine ungültige CalDAV-URL.' });
  }

  // Issue #157: verify credentials against the discovered calendar home.
  // Discovery can succeed unauthenticated on many servers (e.g. /.well-known/caldav
  // redirects without auth). A wrong password would be stored and surface later as an
  // empty calendar. testConnection() issues a PROPFIND with credentials to confirm.
  try {
    await client.testConnection();
  } catch (e) {
    if (e.code === 'OUTBOUND_URL_BLOCKED') {
      return res.status(400).json({ error: BLOCKED_TARGET_ERROR });
    }
    if (e.message === 'NOT_CALDAV_RESPONSE') {
      return res.status(400).json({ error: 'Der Server antwortet nicht wie ein CalDAV-Server. Bitte prüfe die URL.' });
    }
    return res.status(401).json({ error: 'Ungültige Zugangsdaten.' });
  }

  // Issue #248: one server has many spellings (base domain vs. calendar home, trailing
  // slash, host case, ...), so URLs are compared canonically and a path prefix counts as
  // the same account. The session holds env-default/internal accounts that are not in
  // the DB; the DB check covers a cold session; Db.addAccount re-checks atomically.
  const duplicateMessage = 'Dieses Konto ist bereits eingerichtet.';
  const sessionAccounts = req.session?.accounts || [];
  const existsInSession = sessionAccounts.some(
    a => a.username === username && sameAccountUrl(a.url, discoveredUrl)
  );
  const existsInDb = await Db.findAccountByUrlAndUsername(userId, discoveredUrl, username);

  if (existsInSession || existsInDb) {
    return res.status(409).json({ error: duplicateMessage });
  }

  try {
    const { id, displayName: finalDisplayName } = await Db.addAccount(userId, {
      url: discoveredUrl,
      username,
      password,
      displayName
    });
    await Db.claimDetachedMirrors(userId);
    await Db.addSyncJob(userId);
    res.status(201).json({ id, displayName: finalDisplayName, message: 'Account added.' });
  } catch (err) {
    if (err.code === 'ACCOUNT_EXISTS') {
      return res.status(409).json({ error: duplicateMessage });
    }
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

// PATCH /api/accounts/:id — update display name
router.patch('/:id', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
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
    return sendError(res, err);
  }
});

// DELETE /api/accounts/:id — remove account
router.delete('/:id', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
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
    let owner;
    try {
      owner = await Db.getAccountOwner(req.params.id);
    } catch (err) {
      return sendError(res, err, '[accounts] getAccountOwner failed during DELETE fallback:');
    }
    if (owner && owner.userId === req.session.userId) {
      account = owner; // minimal object — only id/userId needed to authorise the DELETE
    }
  }

  if (!account) return res.status(404).json({ error: 'Account not found.' });

  try {
    await Db.deleteAccount(req.params.id);
    res.json({ message: 'Account removed.' });
  } catch (err) {
    return sendError(res, err);
  }
});

// DELETE /api/accounts — remove all (logout)
router.delete('/', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    if (req.session.userId) {
      await Db.deleteUserAccounts(req.session.userId);
    }
    req.session.userId = null;
    res.json({ message: 'All accounts removed.' });
  } catch (err) {
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

// GET /api/accounts/sync-status — get background sync queue status and error messages for user
router.get('/sync-status', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    const jobs = await Db.getSyncJobs(req.session.userId);
    res.json({ jobs });
  } catch (err) {
    return sendError(res, err);
  }
});

// GET /api/accounts/sync-jobs/:id — get specific sync job status and error message
router.get('/sync-jobs/:id', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    const job = await Db.getSyncJobById(req.params.id);
    if (!job || job.userId !== req.session.userId) {
      return res.status(404).json({ error: 'Sync-Job nicht gefunden.' });
    }
    res.json(job);
  } catch (err) {
    return sendError(res, err);
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
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

// DELETE /api/accounts/app-passwords/:id — delete ASP
router.delete('/app-passwords/:id', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert.' });
  }
  try {
    const deleted = await Db.deleteAppPassword(req.params.id, req.session.userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Passwort nicht gefunden.' });
    }
    res.json({ message: 'Passwort entfernt.' });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
