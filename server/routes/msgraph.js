'use strict';
const crypto = require('crypto');
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  getMSGraphConfig,
  createAuthorization,
  exchangeAuthorizationCode,
  fetchAccountEmail
} = require('../utils/msgraph');

const NOT_CONFIGURED = 'Microsoft 365 ist auf diesem Shard nicht eingerichtet (es braucht MSGRAPH_CLIENT_ID und BASE_URL).';

// Get active user ID from request session/header
function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  return null;
}

function stateMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * GET /api/msgraph/accounts
 * List all connected MS Graph / Office 365 accounts for active user (sensitive tokens redacted),
 * and whether connecting a new one is possible on this shard.
 */
router.get('/accounts', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const accounts = await Db.getMSGraphAccounts(userId);
    const sanitized = accounts.map(({ accessToken, refreshToken, ...rest }) => rest);
    res.json({ success: true, available: getMSGraphConfig() !== null, accounts: sanitized });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * GET /api/msgraph/authorize
 * Starts the OAuth 2.0 authorization code flow with PKCE (S256) at Microsoft; state and verifier
 * are bound to this session.
 */
router.get('/authorize', (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const config = getMSGraphConfig();
  if (!config) {
    return res.status(503).json({ error: NOT_CONFIGURED });
  }
  const { url, transaction } = createAuthorization(config);
  req.session.msgraphOAuth = transaction;
  res.redirect(url);
});

/**
 * GET /api/msgraph/callback — the redirect URI registered at Microsoft; mounted without auth.
 * Microsoft sends the browser here cross-site; with COOKIE_SAME_SITE=strict the session cookie is withheld.
 * A page of our own forwards code, state and error to /callback/complete; that navigation starts
 * on this site and carries the cookie. Nothing is checked or stored here.
 */
function forwardCallback(req, res) {
  const config = getMSGraphConfig();
  if (!config) {
    return res.status(503).json({ error: NOT_CONFIGURED });
  }
  const forwarded = new URLSearchParams();
  for (const name of ['code', 'state', 'error']) {
    if (typeof req.query[name] === 'string') forwarded.set(name, req.query[name]);
  }
  // URLSearchParams percent-encodes everything but [A-Za-z0-9*-._]; & is the only character to escape.
  const target = `${config.baseUrl}/api/msgraph/callback/complete?${forwarded}`.replace(/&/g, '&amp;');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(
    `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}">` +
    `<title>Microsoft 365</title></head><body><p><a href="${target}">Weiter zum Kalender</a></p></body></html>`
  );
}

/**
 * GET /api/msgraph/callback/complete
 * The state is always required and must match this session's transaction, which is used once.
 * The response never echoes request parameters.
 */
router.get('/callback/complete', async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const config = getMSGraphConfig();
  if (!config) {
    return res.status(503).json({ error: NOT_CONFIGURED });
  }
  const transaction = req.session.msgraphOAuth;
  delete req.session.msgraphOAuth;
  if (!transaction || !stateMatches(transaction.state, req.query.state)) {
    return res.status(400).type('text/plain').send('Ungültiger OAuth-State. Bitte die Verbindung mit Microsoft 365 erneut starten.');
  }
  if (req.query.error) {
    console.warn('[MSGraph OAuth] authorization was not granted');
    return res.redirect(`${config.baseUrl}/?msgraph=error`);
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    return res.status(400).type('text/plain').send('Autorisierungscode fehlt.');
  }

  try {
    const tokens = await exchangeAuthorizationCode(config, req.query.code, transaction.codeVerifier);
    const accountEmail = await fetchAccountEmail(tokens.accessToken);
    const existing = (await Db.getMSGraphAccounts(userId))
      .find(a => a.accountEmail.toLowerCase() === accountEmail.toLowerCase());
    if (existing) {
      await Db.updateMSGraphAccount(existing.id, { ...tokens, reconnectRequired: false });
    } else {
      await Db.addMSGraphAccount({ userId, accountEmail, ...tokens });
      // #614: calendars kept from an earlier link of this account wait for the user's choice.
      await Db.claimDetachedMirrors(userId);
    }
    await Db.addSyncJob(userId);
    res.redirect(`${config.baseUrl}/?msgraph=connected`);
  } catch (err) {
    console.error('[MSGraph OAuth callback error]', err.message);
    res.redirect(`${config.baseUrl}/?msgraph=error`);
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
 * Requests a sync. The sync worker runs it (sync-worker/msgraph_worker.py, the only Graph sync path).
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

    const job = await Db.addSyncJob(userId);
    res.status(202).json({ success: true, job });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
module.exports.forwardCallback = forwardCallback;
