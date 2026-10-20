'use strict';

/**
 * /api/trash — the shard's trash (#348). Each person sees the calendars, task lists, events
 * and tasks they deleted in the last 30 days, restores them (also the "Undo" toast right after
 * a delete) or purges them for good.
 */

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { resolveUrl } = require('../caldav/parser');
const Db = require('../db');
const { checkCalendarAccess, queueSyncForCalendar } = require('../utils/calendarAuth');
const { sendError, userError } = require('../utils/errorSanitizer');

async function resolveCollection(req, calendarId) {
  const sep = calendarId.indexOf('::');
  const accountId = calendarId.slice(0, sep);
  let account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) account = (await Db.getAccounts(req.session.userId)).find(a => a.id === accountId);
  if (!account) throw userError('ACCOUNT_DISCONNECTED', 409);
  const client = await getClientForAccount(account);
  return { account, client, calendarUrl: resolveUrl(account.url, calendarId.slice(sep + 2)) };
}

async function collectionExists(client, calendarUrl) {
  const res = await client._request('PROPFIND', calendarUrl, { headers: { Depth: '0' } });
  if (res.status === 404) return false;
  if (res.status !== 207 && !res.ok) throw new Error(`PROPFIND ${res.status}: ${res.statusText}`);
  return true;
}

async function putNew(client, url, ics) {
  try {
    await client.put(url, ics, null);
  } catch (err) {
    if (err.message === 'ETAG_CONFLICT') throw userError('TRASH_ITEM_EXISTS', 409);
    throw err;
  }
}

async function restore(req, item) {
  const required = item.kind === 'calendar' ? 'owner' : 'write';
  const access = await checkCalendarAccess(req, item.calendarId, required);
  if (!access.allowed || (required === 'owner' && !access.isOwner)) {
    // access.reason is the English log text of checkCalendarAccess; the user gets the code.
    throw userError('TRASH_RESTORE_DENIED', access.status || 403);
  }
  const { account, client, calendarUrl } = await resolveCollection(req, item.calendarId);
  const { payload } = item;

  if (item.kind === 'calendar') {
    if (await collectionExists(client, calendarUrl)) throw userError('TRASH_CALENDAR_EXISTS', 409);
    await client.mkcalendar(calendarUrl, payload.name, payload.color, payload.components);
    for (const entry of payload.items) {
      await putNew(client, new URL(entry.href, account.url).href, entry.ics);
    }
    return;
  }

  if (!(await collectionExists(client, calendarUrl))) throw userError('TRASH_CALENDAR_GONE', 409);
  await putNew(client, new URL(payload.href, account.url).href, payload.ics);
  // #597: the Microsoft 365 import only reads; its worker creates a restored item at Graph.
  if (payload.msgraph) await Db.addMSGraphRestore(req.session.userId, payload.msgraph.accountId, payload.href);
}

// GET /api/trash — what this person deleted in the last 30 days, newest first.
router.get('/', async (req, res) => {
  try {
    res.json({ items: await Db.listTrashItems(req.session.userId) });
  } catch (err) {
    return sendError(res, err, '[trash GET]');
  }
});

// POST /api/trash/:id/restore — put the item back into Radicale (same href and UID). An item a
// provider deleted (#597) is re-created there by the next sync.
router.post('/:id/restore', async (req, res) => {
  try {
    const item = await Db.getTrashItem(req.params.id, req.session.userId);
    if (!item || item.deletedAt <= Date.now() - Db.TRASH_RETENTION_MS) {
      return res.status(404).json({ error: 'Der Eintrag ist nicht (mehr) im Papierkorb.' });
    }
    await restore(req, item);
    await Db.deleteTrashItem(item.id, req.session.userId);
    // A mirrored calendar carries the restore out to its provider.
    queueSyncForCalendar(item.calendarId, req.session.userId);
    res.json({ message: 'Restored.', kind: item.kind, calendarId: item.calendarId });
  } catch (err) {
    return sendError(res, err, '[trash restore]');
  }
});

// DELETE /api/trash/:id — purge one entry for good.
router.delete('/:id', async (req, res) => {
  try {
    const removed = await Db.deleteTrashItem(req.params.id, req.session.userId);
    if (!removed) return res.status(404).json({ error: 'Der Eintrag ist nicht (mehr) im Papierkorb.' });
    res.json({ message: 'Purged.' });
  } catch (err) {
    return sendError(res, err, '[trash DELETE]');
  }
});

module.exports = router;
