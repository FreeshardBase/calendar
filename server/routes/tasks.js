'use strict';

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { parseCalendarList, parseTaskList, taskToICS } = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');

// ── GET /api/tasks ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const accounts = req.session.accounts || [];
    const allTasks = [];

    const activeAccounts = accounts.filter(account => account.authType !== 'oauth2');

    await Promise.allSettled(
      activeAccounts.map(async (account) => {
        const client = await getClientForAccount(account);
        const calXml = await client.getCalendars();
        let calendars = parseCalendarList(calXml, account.id, account.url, account.username);

        if (account.id === 'internal-caldav' && req.session.userId) {
          try {
            const sharedCals = await Db.getSharedCalendarsForUser(req.session.userId);
            for (const share of sharedCals) {
              const parts = share.calendar_id.split('::');
              const calendarHref = parts[1];
              const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://caldav-server:5232';
              const calendarUrl = localCalDAVCUrl.replace(/\/+$/, '') + calendarHref;
              calendars.push({
                id: share.calendar_id,
                url: calendarUrl,
                name: calendarHref,
                color: '#cccccc'
              });
            }
          } catch (dbErr) {
            console.error('[tasks GET] Failed to fetch shared calendars:', dbErr.message);
          }
        }

        await Promise.allSettled(
          calendars.map(async (cal) => {
            try {
              const tasksXml = await client.getTasks(cal.url);
              const tasks = parseTaskList(tasksXml, cal.id, account.id, cal.url);
              allTasks.push(...tasks);
            } catch (taskErr) {
              console.error(`[tasks GET] Failed to fetch tasks for calendar ${cal.id}:`, taskErr.message);
            }
          })
        );
      })
    );

    res.json(allTasks);
  } catch (err) {
    console.error('[tasks GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tasks — create a task ──────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { calendarId, ...taskData } = req.body;

    if (!calendarId) {
      return res.status(400).json({ error: 'calendarId is required' });
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const uid = uuidv4();
    const task = {
      status: 'NEEDS-ACTION',
      ...taskData,
      uid
    };

    const ics = taskToICS(task);

    const calendarHref = calendarId.split('::').slice(1).join('::');
    const calendarUrl = buildAbsoluteUrl(account.url, calendarHref);
    const taskUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';

    const result = await client.put(taskUrl, ics, null);

    res.status(201).json({
      ...task,
      href: taskUrl,
      etag: result.etag ? result.etag.replace(/"/g, '') : null,
      calendarId
    });
  } catch (err) {
    console.error('[tasks POST]', err.message);
    if (err.message === 'ETAG_CONFLICT') return res.status(409).json({ error: 'Conflict.' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tasks/:uid — update a task ──────────────────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href, ...taskData } = req.body;

    if (!href) return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const uid = req.params.uid;
    const task = { ...taskData, uid };

    if (task.status === 'COMPLETED' && !task.completed) {
      task.completed = new Date().toISOString();
      task.percentComplete = 100;
    }

    const ics = taskToICS(task);
    const taskUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch = etag ? (etag.startsWith('"') ? etag : `"${etag}"`) : null;

    const result = await client.put(taskUrl, ics, ifMatch);

    res.json({
      ...task,
      href,
      etag: result.etag ? result.etag.replace(/"/g, '') : etag,
      calendarId
    });
  } catch (err) {
    console.error('[tasks PUT]', err.message);
    if (err.message === 'ETAG_CONFLICT') {
      return res.status(409).json({ error: 'Task modified by another client.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tasks/:uid — delete a task ──────────────────────────────────
router.delete('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href } = req.body;

    if (!href) return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const taskUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch = etag ? (etag.startsWith('"') ? etag : `"${etag}"`) : null;

    await client.delete(taskUrl, ifMatch);

    res.json({ message: 'Task deleted.' });
  } catch (err) {
    console.error('[tasks DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function resolveAccount(req, calendarId) {
  const accountId = calendarId.split('::')[0];
  const account = (req.session.accounts || []).find(a => a.id === accountId);
  if (!account) return { account: null, client: null };

  const client = await getClientForAccount(account);
  return { account, client };
}

function buildAbsoluteUrl(baseUrl, href) {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return baseUrl.replace(/\/+$/, '') + '/' + href.replace(/^\/+/, '');
  }
}

module.exports = router;
