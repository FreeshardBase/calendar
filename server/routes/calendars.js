'use strict';

const express = require('express');
const router = express.Router();
const CalDAVClient = require('../caldav/client');
const { parseCalendarList } = require('../caldav/parser');

// GET /api/calendars — fetch all calendars from all accounts
router.get('/', async (req, res) => {
  const accounts = req.session.accounts || [];
  const allCalendars = [];
  const errors = [];

  await Promise.allSettled(
    accounts.map(async (account) => {
      const client = new CalDAVClient({
        url:      account.url,
        username: account.username,
        password: account.password
      });

      const xml = await client.getCalendars();
      const calendars = parseCalendarList(xml, account.id, account.url);
      allCalendars.push(...calendars);
    })
  ).then(results => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push({ accountId: accounts[i].id, error: r.reason.message });
        console.error(`[calendars] Account ${accounts[i].id}:`, r.reason.message);
      }
    });
  });

  res.json({ calendars: allCalendars, errors });
});

// POST /api/calendars — create a new calendar collection
router.post('/', async (req, res) => {
  try {
    const { accountId, name, color } = req.body;

    if (!accountId || !name) {
      return res.status(400).json({ error: 'accountId and name are required' });
    }

    const account = (req.session.accounts || []).find(a => a.id === accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = new CalDAVClient({
      url:      account.url,
      username: account.username,
      password: account.password
    });

    const slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const calendarUrl = account.url.replace(/\/+$/, '') + '/' + slug + '/';

    await client.mkcalendar(calendarUrl, name, color || '#7c3aed');

    res.status(201).json({
      message: 'Calendar created',
      url: calendarUrl,
      id: `${accountId}::${new URL(calendarUrl).pathname}`
    });
  } catch (err) {
    console.error('[calendars POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: resolve account + calendar URL from calendarId ──────────────────
function resolveCalendar(req, calendarId) {
  const sep = calendarId.indexOf('::');
  if (sep === -1) return {};
  const accountId    = calendarId.slice(0, sep);
  const calendarHref = calendarId.slice(sep + 2);
  const account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) return {};

  const client = new CalDAVClient({
    url: account.url, username: account.username, password: account.password
  });
  const calendarUrl = calendarHref.startsWith('http')
    ? calendarHref
    : new URL(calendarHref, account.url).href;

  return { account, client, calendarUrl };
}

// PATCH /api/calendars/:id — rename and/or recolor a calendar
router.patch('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { name, color } = req.body;

    if (!name && !color) {
      return res.status(400).json({ error: 'At least name or color is required' });
    }

    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const props = [];
    if (name)  props.push(`<d:displayname>${escXML(name)}</d:displayname>`);
    if (color) props.push(`<a:calendar-color>${escXML(color)}</a:calendar-color>`);

    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">
  <d:set>
    <d:prop>
      ${props.join('\n      ')}
    </d:prop>
  </d:set>
</d:propertyupdate>`;

    const patchRes = await client._request('PROPPATCH', calendarUrl, { body });
    if (!patchRes.ok && patchRes.status !== 207) {
      const text = await patchRes.text().catch(() => '');
      throw new Error(`PROPPATCH ${patchRes.status}: ${text.slice(0, 200) || patchRes.statusText}`);
    }

    res.json({ message: 'Calendar updated', calendarId, name, color });
  } catch (err) {
    console.error('[calendars PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendars/:id — delete a calendar collection and all its events
router.delete('/:id', async (req, res) => {
  try {
    const calendarId = decodeURIComponent(req.params.id);
    const { client, calendarUrl } = resolveCalendar(req, calendarId);
    if (!client) return res.status(404).json({ error: 'Account not found' });

    const delRes = await client._request('DELETE', calendarUrl);
    if (!delRes.ok && delRes.status !== 204) {
      const text = await delRes.text().catch(() => '');
      throw new Error(`DELETE ${delRes.status}: ${text.slice(0, 200) || delRes.statusText}`);
    }

    res.json({ message: 'Calendar deleted', calendarId });
  } catch (err) {
    console.error('[calendars DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function escXML(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
