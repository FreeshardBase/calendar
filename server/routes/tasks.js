'use strict';

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { formatIfMatch } = require('../caldav/client');
const { parseCalendarList, parseTaskList, taskToICS, reconcileTaskStatus, isNoOpTaskSave, resolveUrl, parseICSToTask, advanceRecurringTask } = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { checkCalendarAccess, extractCalendarIdFromHref } = require('../utils/calendarAuth');

// ── GET /api/tasks ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const accounts = req.session.accounts || [];
    const allTasks = [];

    const activeAccounts = accounts.filter(account => account.authType !== 'oauth2');
    const errors = [];
    let successfulCalendars = 0;

    const hasCalDAVEnv = Boolean(process.env.CALDAVURL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD);
    await Promise.allSettled(
      activeAccounts.map(async (account) => {
        if (
          (account.id === 'internal-caldav' && process.env.DISABLE_INTERNAL_CALDAV === '1') ||
          (account.id === 'env-default' && !hasCalDAVEnv && process.env.DISABLE_INTERNAL_CALDAV === '1')
        ) {
          return;
        }
        try {
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

          if (req.query.calendarId) {
            calendars = calendars.filter(c => c.id === req.query.calendarId);
          }

          await Promise.allSettled(
            calendars.map(async (cal) => {
              try {
                const tasksXml = await client.getTasks(cal.url);
                const tasks = parseTaskList(tasksXml, cal.id, account.id, cal.url);
                allTasks.push(...tasks);
                successfulCalendars++;
              } catch (taskErr) {
                console.error(`[tasks GET] Failed to fetch tasks for calendar ${cal.id}:`, taskErr.message);
                errors.push({ accountId: account.id, calendarId: cal.id, error: taskErr.message });
              }
            })
          );
        } catch (accountErr) {
          console.error(`[tasks GET] Failed to fetch calendars for account ${account.id}:`, accountErr.message);
          errors.push({ accountId: account.id, error: accountErr.message });
        }
      })
    );

    if (errors.length > 0) {
      res.setHeader('X-CalDAV-Error', JSON.stringify(errors.map(e => e.error)));
    }

    const specificCalendarFailed = req.query.calendarId && errors.some(e => e.calendarId === req.query.calendarId);
    const allAccountsFailed = activeAccounts.length > 0 && errors.length >= activeAccounts.length && successfulCalendars === 0;

    if (specificCalendarFailed || allAccountsFailed) {
      return res.status(502).json({
        error: 'Failed to fetch tasks from CalDAV server',
        errors
      });
    }

    let filteredTasks = allTasks;
    if (req.query.category || req.query.tag) {
      const target = String(req.query.category || req.query.tag).trim().toLowerCase();
      filteredTasks = filteredTasks.filter(t =>
        Array.isArray(t.categories) && t.categories.some(c => String(c).trim().toLowerCase() === target)
      );
    }

    res.json(filteredTasks);
  } catch (err) {
    console.error('[tasks GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const ICAL = require('ical.js');

function validateTaskInput(taskData) {
  if (!taskData || typeof taskData !== 'object') {
    return { error: 'Task data must be an object' };
  }

  if ('dtstart' in taskData && taskData.dtstart !== null && taskData.dtstart !== undefined && taskData.dtstart !== '') {
    const dt = new Date(taskData.dtstart);
    if (isNaN(dt.getTime())) {
      return { error: 'Invalid dtstart date format' };
    }
  }

  if ('due' in taskData && taskData.due !== null && taskData.due !== undefined && taskData.due !== '') {
    const dt = new Date(taskData.due);
    if (isNaN(dt.getTime())) {
      return { error: 'Invalid due date format' };
    }
  }

  if ('completed' in taskData && taskData.completed !== null && taskData.completed !== undefined && taskData.completed !== '') {
    const dt = new Date(taskData.completed);
    if (isNaN(dt.getTime())) {
      return { error: 'Invalid completed date format' };
    }
  }

  if ('duration' in taskData && taskData.duration !== null && taskData.duration !== undefined && taskData.duration !== '') {
    const durationStr = String(taskData.duration).trim();
    if (!/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.test(durationStr)) {
      return { error: 'Invalid duration format (must be ISO 8601 duration, e.g. PT2H, P1D)' };
    }
  }

  if ('recurrence' in taskData && taskData.recurrence !== null && taskData.recurrence !== undefined && taskData.recurrence !== '') {
    const rruleSanitized = String(taskData.recurrence).split(/[\r\n]/)[0].replace(/^RRULE:/i, '').trim();
    try {
      const recur = ICAL.Recur.fromString(rruleSanitized);
      if (!recur || !recur.freq) {
        return { error: 'Invalid recurrence rule syntax' };
      }
    } catch (_) {
      return { error: 'Invalid recurrence rule syntax' };
    }
  }

  if ('priority' in taskData && taskData.priority !== null && taskData.priority !== undefined && taskData.priority !== '') {
    const p = parseInt(taskData.priority, 10);
    if (isNaN(p) || p < 0 || p > 9) {
      return { error: 'Invalid priority (must be integer between 0 and 9)' };
    }
  }

  if ('percentComplete' in taskData || 'percent-complete' in taskData) {
    const pctRaw = taskData.percentComplete !== undefined ? taskData.percentComplete : taskData['percent-complete'];
    if (pctRaw !== null && pctRaw !== undefined && pctRaw !== '') {
      const pct = parseInt(pctRaw, 10);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        return { error: 'Invalid percentComplete (must be integer between 0 and 100)' };
      }
    }
  }

  return null;
}

// ── POST /api/tasks — create a task ──────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { calendarId, ...taskData } = req.body;

    if (!calendarId) {
      return res.status(400).json({ error: 'calendarId is required' });
    }

    const validationErr = validateTaskInput(taskData);
    if (validationErr) {
      return res.status(400).json(validationErr);
    }

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const uid = uuidv4();
    const task = reconcileTaskStatus({
      status: 'NEEDS-ACTION',
      ...taskData,
      uid
    });

    const ics = taskToICS(task);

    const calendarHref = calendarId.split('::').slice(1).join('::');
    const calendarUrl = buildAbsoluteUrl(account.url, calendarHref);
    const taskUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';

    const result = await client.put(taskUrl, ics, null);

    res.status(201).json({
      ...task,
      href: taskUrl,
      etag: (result && result.etag) ? result.etag : null,
      calendarId
    });
  } catch (err) {
    console.error('[tasks POST]', err.message);
    if (err.message === 'ETAG_CONFLICT') return res.status(409).json({ error: 'Conflict.' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/tasks/:uid — update an existing task ─────────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    const { calendarId, etag, href, ...taskData } = req.body;

    if (!href) return res.status(400).json({ error: 'href is required' });
    if (!calendarId) return res.status(400).json({ error: 'calendarId is required' });

    const validationErr = validateTaskInput(taskData);
    if (validationErr) {
      return res.status(400).json(validationErr);
    }

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    if (derivedCalId && derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const taskUrl = buildAbsoluteUrl(account.url, href);
    let task = reconcileTaskStatus({ uid: req.params.uid, ...taskData });

    let current = null;
    try {
      current = await client.get(taskUrl);
    } catch (_) {
      current = null;
    }

    const existingIcs = current ? current.ics : null;

    if (existingIcs) {
      const existingTask = parseICSToTask(existingIcs);
      if (existingTask) {
        if (!('dtstart' in taskData) && existingTask.dtstart !== undefined) {
          task.dtstart = existingTask.dtstart;
          if (existingTask.dtstartIsDate !== undefined) task.dtstartIsDate = existingTask.dtstartIsDate;
        } else if (!('dtstartIsDate' in taskData) && existingTask.dtstartIsDate !== undefined) {
          task.dtstartIsDate = existingTask.dtstartIsDate;
        }
        const hasDueInPayload = 'due' in taskData && taskData.due !== null && taskData.due !== undefined && taskData.due !== '';
        const hasDurationInPayload = 'duration' in taskData && taskData.duration !== null && taskData.duration !== undefined && taskData.duration !== '';

        if (hasDueInPayload && !hasDurationInPayload) {
          task.due = taskData.due;
          if (taskData.dueIsDate !== undefined) task.dueIsDate = taskData.dueIsDate;
          task.duration = null;
        } else if (hasDurationInPayload && !hasDueInPayload) {
          task.duration = taskData.duration;
          task.due = null;
        } else if (hasDueInPayload && hasDurationInPayload) {
          if (existingTask.due && new Date(taskData.due).getTime() !== new Date(existingTask.due).getTime()) {
            task.due = taskData.due;
            if (taskData.dueIsDate !== undefined) task.dueIsDate = taskData.dueIsDate;
            task.duration = null;
          } else {
            task.duration = taskData.duration;
            task.due = null;
          }
        } else {
          if (existingTask.duration) {
            task.duration = existingTask.duration;
            task.due = null;
          } else if (existingTask.due) {
            task.due = existingTask.due;
            if (existingTask.dueIsDate !== undefined) task.dueIsDate = existingTask.dueIsDate;
            task.duration = null;
          }
        }
        if (!('percentComplete' in taskData) && !('percent-complete' in taskData) && existingTask.percentComplete !== undefined) {
          task.percentComplete = existingTask.percentComplete;
        }
        if (!('completed' in taskData) && existingTask.completed !== undefined) {
          task.completed = existingTask.completed;
        }
        if (!('completedHistory' in taskData) && existingTask.completedHistory !== undefined) {
          task.completedHistory = existingTask.completedHistory;
        }
      }
    }

    if (task.status === 'COMPLETED' && (task.recurrence || (existingIcs && existingIcs.includes('RRULE:')))) {
      const fullTask = parseICSToTask(existingIcs || '', { uid: req.params.uid, ...taskData });
      const advanced = advanceRecurringTask(fullTask || task);
      if (advanced) {
        task = advanced;
      }
    }

    // Issue #261: skip the CalDAV PUT entirely when no meaningful field changed.
    // This prevents the scratch ICS builder from stripping RRULE and other
    // properties that were not echoed back by the frontend.
    if (isNoOpTaskSave(existingIcs, taskData)) {
      return res.json({
        ...task,
        href,
        etag: (current && current.etag) ? current.etag : etag,
        calendarId
      });
    }

    const ics = taskToICS(task, existingIcs);
    const ifMatch = (current && current.etag) ? formatIfMatch(current.etag) : (etag ? formatIfMatch(etag) : null);

    let result;
    try {
      result = await client.put(taskUrl, ics, ifMatch);
    } catch (putErr) {
      if (putErr.message === 'ETAG_CONFLICT') {
        result = await client.put(taskUrl, ics, null);
      } else {
        throw putErr;
      }
    }

    res.json({
      ...task,
      href,
      etag: (result && result.etag) ? result.etag : etag,
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

    const access = await checkCalendarAccess(req, calendarId, 'write');
    if (!access.allowed) {
      return res.status(access.status || 403).json({ error: access.reason });
    }

    const accountId = calendarId.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    if (derivedCalId && derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const taskUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch = etag ? formatIfMatch(etag) : null;

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
  return resolveUrl(baseUrl, href);
}

router.validateTaskInput = validateTaskInput;

module.exports = router;
