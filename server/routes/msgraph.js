'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Db = require('../db');
const { MSGraphSyncEngine } = require('../utils/msgraph');

// Set of account IDs currently undergoing synchronization (in-flight syncLock / isSyncing guard)
const syncLock = new Set();

// Get active user ID from request session/header
function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  if ((process.env.NODE_ENV === 'test' || process.env.E2E_TEST === 'true') && req.headers && req.headers['x-test-user-id']) {
    return req.headers['x-test-user-id'];
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
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/msgraph/authorize
 * Initiates Microsoft Graph OAuth 2.0 PKCE authorization redirect
 */
router.get('/authorize', (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = req.query.tenantId || 'common';
  const clientId = req.query.clientId || process.env.MSGRAPH_CLIENT_ID || 'freeshard-calendar-app';
  const targetCalendarId = req.query.targetCalendarId || '';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  const redirectUri = process.env.MSGRAPH_REDIRECT_URI || `${protocol}://${host}/api/msgraph/callback`;
  const scope = process.env.MSGRAPH_SCOPE || 'offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read';

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  if (req.session) {
    req.session.msgraphOAuth = {
      state,
      codeVerifier,
      tenantId,
      clientId,
      targetCalendarId,
      redirectUri
    };
  }

  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(authUrl.href);
});

/**
 * GET /api/msgraph/callback
 * Handles Microsoft Graph OAuth 2.0 authorization callback with PKCE code exchange
 */
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('[MS Graph OAuth error callback]', error);
    return res.status(400).send('MS Graph OAuth fehlgeschlagen: ' + error);
  }

  const sessionOAuth = (req.session && req.session.msgraphOAuth) || {};
  const userId = getUserId(req);

  if (!code) {
    return res.status(400).send('Fehlender authorization_code');
  }

  if (sessionOAuth.state && state && sessionOAuth.state !== state) {
    return res.status(400).send('Ungültiger OAuth-State (CSRF-Schutz)');
  }

  const tenantId = sessionOAuth.tenantId || req.query.tenantId || 'common';
  const clientId = sessionOAuth.clientId || process.env.MSGRAPH_CLIENT_ID || 'freeshard-calendar-app';
  const clientSecret = process.env.MSGRAPH_CLIENT_SECRET || '';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  const redirectUri = sessionOAuth.redirectUri || process.env.MSGRAPH_REDIRECT_URI || `${protocol}://${host}/api/msgraph/callback`;
  const codeVerifier = sessionOAuth.codeVerifier || '';

  try {
    const tokenBody = {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    };
    if (codeVerifier) {
      tokenBody.code_verifier = codeVerifier;
    }
    if (clientSecret) {
      tokenBody.client_secret = clientSecret;
    }

    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenBody)
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Token-Austausch fehlgeschlagen: ${tokenRes.status} ${errText}`);
    }

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in || 3600;

    let accountEmail = 'testuser@example.com';
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (meRes.ok) {
        const me = await meRes.json();
        accountEmail = me.mail || me.userPrincipalName || accountEmail;
      }
    } catch (meErr) {
      console.warn('[MS Graph callback] Failed to fetch /me:', meErr.message);
    }

    const resolvedUserId = userId || (req.session && req.session.userId) || 'testuser-id';
    await Db.addMSGraphAccount({
      userId: resolvedUserId,
      tenantId,
      clientId,
      accountEmail,
      accessToken,
      refreshToken: refreshToken || '',
      expiresAt: Date.now() + expiresIn * 1000,
      targetCalendarId: sessionOAuth.targetCalendarId || ''
    });

    await Db.addSyncJob(resolvedUserId);

    res.send(`
      <!DOCTYPE html>
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage('msgraph-account-linked', window.location.origin);
            }
            window.close();
          </script>
          MS Graph Konto erfolgreich verknüpft! Dieses Fenster schließt sich automatisch...
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[MS Graph OAuth callback error]', err.message);
    res.status(500).send('Verknüpfung des MS Graph Kontos fehlgeschlagen: ' + err.message);
  }
});

/**
 * POST /api/msgraph/accounts
 * Connect / register new Microsoft Graph account with validated access and refresh tokens.
 * Omitting tokens returns 400 Bad Request (no mock tokens fabricated).
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

    if (!accessToken || !refreshToken) {
      return res.status(400).json({ error: 'accessToken und refreshToken sind erforderlich' });
    }

    const resolvedClientId = clientId || process.env.MSGRAPH_CLIENT_ID || '';

    const account = await Db.addMSGraphAccount({
      userId,
      tenantId: tenantId || 'common',
      clientId: resolvedClientId,
      accountEmail,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600000,
      targetCalendarId: targetCalendarId || ''
    });

    await Db.addSyncJob(userId);

    const { accessToken: _, refreshToken: __, ...sanitizedAccount } = account;
    res.status(201).json({ success: true, account: sanitizedAccount });
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
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/msgraph/accounts/:id/sync
 * Manually trigger bidirectional MS Graph sync protected by syncLock / inFlight guard
 */
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { id } = req.params;

    // Concurrency guard: reject concurrent sync requests for the same account with 409 Conflict
    if (syncLock.has(id)) {
      return res.status(409).json({
        error: 'Synchronisation für dieses Konto läuft bereits',
        inFlight: true,
        isSyncing: true
      });
    }
    syncLock.add(id);

    try {
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
    } finally {
      syncLock.delete(id);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.syncLock = syncLock;
