'use strict';
const log = require('../utils/logger');
const { sendError, describeError, userError } = require('../utils/errorSanitizer');
const { setUnparseableHeader } = require('../utils/unparseableReport');
const { CALDAV_REPORT_CONCURRENCY, forEachLimited } = require('../utils/caldavFanout');

const express = require('express');
const router = express.Router();
const { getClientForAccount } = require('../caldav/helper');
const { formatIfMatch } = require('../caldav/client');
const { parseCalendarList, parseTaskList, taskToICS, reconcileTaskStatus, isNoOpTaskSave, resolveUrl, parseICSToTask, advanceRecurringTask } = require('../caldav/parser');
const { v4: uuidv4 } = require('uuid');
const Db = require('../db');
const { trashItem } = require('../utils/trash');
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
    const unparseable = [];
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
              log.error('[tasks GET] Failed to fetch shared calendars:', dbErr.message);
            }
          }

          if (req.query.calendarId) {
            calendars = calendars.filter(c => c.id === req.query.calendarId);
          }

          await forEachLimited(calendars, CALDAV_REPORT_CONCURRENCY, async (cal) => {
            try {
              const tasksXml = await client.getTasks(cal.url);
              const parseErrors = [];
              const tasks = parseTaskList(tasksXml, cal.id, account.id, cal.url, parseErrors);
              allTasks.push(...tasks);
              for (const pe of parseErrors) unparseable.push({ calendarId: cal.id, href: pe.href, error: pe.error });
              successfulCalendars++;
            } catch (taskErr) {
              log.error(`[tasks GET] Failed to fetch tasks for calendar ${cal.id}:`, taskErr.message);
              const { status, message } = describeError(taskErr);
              errors.push({ accountId: account.id, calendarId: cal.id, status, error: message });
            }
          });
        } catch (accountErr) {
          log.error(`[tasks GET] Failed to fetch calendars for account ${account.id}:`, accountErr.message);
          const { status, message } = describeError(accountErr);
          errors.push({ accountId: account.id, status, error: message });
        }
      })
    );

    if (errors.length > 0) {
      res.setHeader('X-CalDAV-Error', JSON.stringify(errors.map(e => e.error)));
    }
    setUnparseableHeader(res, unparseable);

    const specificCalendarFailed = req.query.calendarId && errors.some(e => e.calendarId === req.query.calendarId);
    const allAccountsFailed = activeAccounts.length > 0 && errors.length >= activeAccounts.length && successfulCalendars === 0;

    if (specificCalendarFailed || allAccountsFailed) {
      const failure = errors.find(e => req.query.calendarId && e.calendarId === req.query.calendarId) || errors[0];
      return res.status(failure.status).json({ error: failure.error, errors });
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
    return sendError(res, err, '[tasks GET]');
  }
});

const ICAL = require('ical.js');
const { assertValidAlarms } = require('../utils/ical');
const VTODO_STATUSES = new Set(['NEEDS-ACTION', 'COMPLETED', 'IN-PROCESS', 'CANCELLED']);

function validateTaskInput(taskData) {
  if (!taskData || typeof taskData !== 'object') {
    return { error: 'Task data must be an object' };
  }

  // #508: a malformed TRIGGER is refused before it is serialised, as for events (#128).
  try {
    assertValidAlarms(taskData.alarms);
  } catch (e) {
    return { error: e.message };
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

  // #518: the parent's UID, written as RELATED-TO;RELTYPE=PARENT.
  if ('parentUid' in taskData && taskData.parentUid !== null && taskData.parentUid !== undefined) {
    const p = taskData.parentUid;
    if (typeof p !== 'string' || p.length > 255 || /[\x00-\x1f\x7f]/.test(p)) {
      return { error: 'Invalid parentUid (must be a single-line UID of at most 255 characters)' };
    }
  }

  // RFC 5545 §3.8.1.11: the only STATUS values defined for VTODO.
  if ('status' in taskData && taskData.status !== null && taskData.status !== undefined && taskData.status !== '') {
    if (!VTODO_STATUSES.has(String(taskData.status).trim().toUpperCase())) {
      return { error: 'Invalid status (must be NEEDS-ACTION, COMPLETED, IN-PROCESS or CANCELLED)' };
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
    // completedInstance is derived server-side by advanceRecurringTask only (#95).
    const { calendarId, completedInstance: _clientInstance, ...taskData } = req.body;

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

    const calendarHref = calendarId.split('::').slice(1).join('::');
    const calendarUrl = buildAbsoluteUrl(account.url, calendarHref);
    if (!(await acceptsTasks(client, calendarUrl))) return refuseNonTaskCollection(res);

    const uid = uuidv4();
    const task = reconcileTaskStatus({
      status: 'NEEDS-ACTION',
      ...taskData,
      uid
    });

    const ics = taskToICS(task);

    const taskUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';

    const result = await client.put(taskUrl, ics, null);

    res.status(201).json({
      ...task,
      href: taskUrl,
      etag: (result && result.etag) ? result.etag : null,
      calendarId
    });
  } catch (err) {
    return sendError(res, err, '[tasks POST]');
  }
});

// ── PUT /api/tasks/:uid — update an existing task ─────────────────────────────
router.put('/:uid', async (req, res) => {
  try {
    // completedInstance is derived server-side by advanceRecurringTask only (#95).
    const { calendarId, sourceCalendarId, etag, href, completedInstance: _clientInstance, ...taskData } = req.body;

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

    // The task is stored in `sourceCalendarId` and was given another list in the dialog (#495).
    const moving = Boolean(sourceCalendarId && sourceCalendarId !== calendarId);
    const storedIn = moving ? sourceCalendarId : calendarId;
    if (moving) {
      const sourceAccess = await checkCalendarAccess(req, sourceCalendarId, 'write');
      if (!sourceAccess.allowed) {
        return res.status(sourceAccess.status || 403).json({ error: sourceAccess.reason });
      }
    }

    const accountId = storedIn.split('::')[0];
    const derivedCalId = extractCalendarIdFromHref(accountId, href);
    // An href that names no calendar (undecodable, or above calendar level)
    // cannot be authorized, so it is refused rather than left unchecked (#232).
    if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
    if (derivedCalId !== storedIn) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const target = await resolveAccount(req, calendarId);
    const source = moving ? await resolveAccount(req, sourceCalendarId) : target;
    if (!target.account || !source.account) return res.status(404).json({ error: 'Account not found' });

    const targetCalendarUrl = buildAbsoluteUrl(target.account.url, calendarId.split('::').slice(1).join('::'));
    if (!(await acceptsTasks(target.client, targetCalendarUrl))) return refuseNonTaskCollection(res);

    const { client } = source;
    const taskUrl = buildAbsoluteUrl(source.account.url, href);
    let task = reconcileTaskStatus({ ...taskData, uid: req.params.uid });

    let current = null;
    try {
      current = await client.get(taskUrl);
    } catch (err) {
      // A new resource has nothing to merge with; any other failure must not become an overwrite (#343).
      // A task being moved must exist where it is moved from.
      if (moving || !/^GET (404|410):/.test(err.message)) throw err;
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
          if (taskData.status === 'COMPLETED') {
            task.percentComplete = 100;
          } else {
            task.percentComplete = existingTask.percentComplete;
          }
        }
        if (!('completed' in taskData) && existingTask.completed !== undefined) {
          if (taskData.status === 'COMPLETED' && !existingTask.completed) {
            task.completed = task.completed || new Date().toISOString();
          } else {
            task.completed = existingTask.completed;
          }
        }
        if (!('completedHistory' in taskData) && existingTask.completedHistory !== undefined) {
          task.completedHistory = existingTask.completedHistory;
        }
        if (!('recurrence' in taskData) && existingTask.recurrence !== undefined) {
          task.recurrence = existingTask.recurrence;
        }
        if (!('title' in taskData) && existingTask.title !== undefined) {
          task.title = existingTask.title;
        }
        if (!('categories' in taskData) && existingTask.categories !== undefined) {
          task.categories = existingTask.categories;
        }
      }
    }

    if (task.status === 'COMPLETED' && (task.recurrence || (existingIcs && existingIcs.includes('RRULE:')))) {
      const fullTask = parseICSToTask(existingIcs || '', { ...taskData, uid: req.params.uid });
      const targetTask = { ...(fullTask || {}), ...task, status: 'COMPLETED' };
      const advanced = advanceRecurringTask(targetTask);
      if (advanced) {
        task = advanced;
      } else {
        task = {
          ...task,
          status: 'COMPLETED',
          percentComplete: 100,
          completed: task.completed || new Date().toISOString(),
          completedHistory: targetTask.completedHistory || task.completedHistory
        };
      }
    }

    // Issue #261: skip the CalDAV PUT entirely when no meaningful field changed.
    // This prevents the scratch ICS builder from stripping RRULE and other
    // properties that were not echoed back by the frontend.
    const { completedInstance: _writtenInstance, ...taskResponse } = task;
    if (!moving && isNoOpTaskSave(existingIcs, taskData)) {
      return res.json({
        ...taskResponse,
        href,
        etag: (current && current.etag) ? current.etag : etag,
        calendarId
      });
    }

    const ics = taskToICS(task, existingIcs);

    if (moving) {
      return await moveTask(res, { source, target, taskUrl, current, targetCalendarUrl, ics, taskResponse, calendarId, uid: req.params.uid });
    }
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
      ...taskResponse,
      href,
      etag: (result && result.etag) ? result.etag : etag,
      calendarId
    });
  } catch (err) {
    return sendError(res, err, '[tasks PUT]');
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
    // An href that names no calendar (undecodable, or above calendar level)
    // cannot be authorized, so it is refused rather than left unchecked (#232).
    if (!derivedCalId) return res.status(400).json({ error: 'Invalid href' });
    if (derivedCalId !== calendarId) {
      const hrefAccess = await checkCalendarAccess(req, derivedCalId, 'write');
      if (!hrefAccess.allowed) {
        return res.status(hrefAccess.status || 403).json({ error: hrefAccess.reason });
      }
    }

    const { account, client } = await resolveAccount(req, calendarId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const taskUrl = buildAbsoluteUrl(account.url, href);
    const ifMatch = etag ? formatIfMatch(etag) : null;

    // #348: the copy goes to the trash first; a failed delete takes it out again.
    const stored = await client.get(taskUrl);
    const trashId = await trashItem(req.session.userId, {
      kind: 'task', calendarId: derivedCalId, href: new URL(taskUrl).pathname, ics: stored.ics
    });
    try {
      await client.delete(taskUrl, ifMatch);
    } catch (delErr) {
      await Db.deleteTrashItem(trashId, req.session.userId);
      throw delErr;
    }

    res.json({ message: 'Task deleted.', trashId });
  } catch (err) {
    return sendError(res, err, '[tasks DELETE]');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPONENT_SET_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

/**
 * True if the calendar collection's supported-calendar-component-set admits VTODO (#495).
 * Radicale stores a VTODO in any collection, so the app has to ask: the local mirror of a Google
 * calendar is created VEVENT-only, because Google's CalDAV has no tasks and the sync worker could
 * never carry a task there.
 */
async function acceptsTasks(client, calendarUrl) {
  const xml = await client.propfind(calendarUrl, 0, COMPONENT_SET_PROPFIND);
  const [calendar] = parseCalendarList(xml, '', calendarUrl, null);
  return Boolean(calendar && calendar.supportsVTODO);
}

function refuseNonTaskCollection(res) {
  return sendError(res, userError('TASK_LIST_REQUIRED', 422));
}

/**
 * Move a task into another list (#495), like an event move (#494): the task is first created in
 * the target collection under the same UID and only then deleted from the source, so a failure
 * never loses it. If the source cannot be deleted (gone, changed meanwhile, refused), the new
 * copy is removed again and the move fails as a whole.
 */
async function moveTask(res, { source, target, taskUrl, current, targetCalendarUrl, ics, taskResponse, calendarId, uid }) {
  const targetUrl = targetCalendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(uid) + '.ics';

  let created;
  try {
    created = await target.client.put(targetUrl, ics, null);
  } catch (putErr) {
    if (putErr.message === 'ETAG_CONFLICT') {
      return res.status(409).json({ error: 'The target list already holds a task with this UID' });
    }
    throw putErr;
  }

  try {
    await source.client.delete(taskUrl, current.etag);
  } catch (delErr) {
    try {
      await target.client.delete(targetUrl, created.etag);
    } catch (rollbackErr) {
      log.error('[tasks move] Removing the copy in the target list failed:', rollbackErr.message);
      throw new Error(`Move failed and the copy in the target list could not be removed again: ${delErr.message}`);
    }
    if (delErr.message === 'ETAG_CONFLICT') {
      return res.status(409).json({ error: 'The task was changed meanwhile; it was not moved' });
    }
    throw delErr;
  }

  return res.json({
    ...taskResponse,
    href: targetUrl,
    etag: created.etag || null,
    calendarId
  });
}

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
