'use strict';

// Issue #498: per-user UI choices that follow the user to every browser.
// Issue #509: the week/day grid's second time zone is one of them (the user's calendar setting, #355).
// Issue #518: so is, per task list, whether its due tasks show in the calendar views.

const express = require('express');
const router = express.Router();
const Db = require('../db');

const TASK_VIEWS = ['list', 'kanban'];

// The IANA name under which Intl knows the zone (fixes the letter case), or null for anything else.
// The pattern keeps out offset strings such as "+01:00", which newer engines accept as zones.
function ianaZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch (err) {
    if (err instanceof RangeError) return null; // Intl's answer for an unknown zone
    throw err;
  }
  return resolved;
}

async function readPreferences(userId) {
  return {
    taskView: await Db.getTaskViewPreference(userId),
    secondaryTimezone: await Db.getSecondaryTimezonePreference(userId),
    tasksHiddenInCalendar: await Db.getTasksHiddenInCalendar(userId),
  };
}

// GET /api/preferences
router.get('/', async (req, res, next) => {
  try {
    res.json(await readPreferences(req.session.userId));
  } catch (err) {
    next(err);
  }
});

// PUT /api/preferences — { taskView?: 'list' | 'kanban', secondaryTimezone?: '<IANA zone>' | null,
//   taskListInCalendar?: { calendarId: '<id>', shown: boolean } }
router.put('/', async (req, res, next) => {
  const body = req.body || {};
  const hasTaskView = Object.prototype.hasOwnProperty.call(body, 'taskView');
  const hasZone = Object.prototype.hasOwnProperty.call(body, 'secondaryTimezone');
  const hasListToggle = Object.prototype.hasOwnProperty.call(body, 'taskListInCalendar');
  if (!hasTaskView && !hasZone && !hasListToggle) {
    return res.status(400).json({ error: 'Expected taskView, secondaryTimezone or taskListInCalendar' });
  }
  if (hasTaskView && !TASK_VIEWS.includes(body.taskView)) {
    return res.status(400).json({ error: `taskView must be one of: ${TASK_VIEWS.join(', ')}` });
  }
  const zone = hasZone && body.secondaryTimezone !== null ? ianaZone(body.secondaryTimezone) : null;
  if (hasZone && body.secondaryTimezone !== null && zone === null) {
    return res.status(400).json({ error: 'secondaryTimezone must be an IANA time zone name or null' });
  }
  const toggle = body.taskListInCalendar;
  if (hasListToggle && !(toggle && typeof toggle.calendarId === 'string' && toggle.calendarId.length > 0
    && toggle.calendarId.length <= 1024 && typeof toggle.shown === 'boolean')) {
    return res.status(400).json({ error: 'taskListInCalendar must be { calendarId: string, shown: boolean }' });
  }
  try {
    const userId = req.session.userId;
    if (hasTaskView) await Db.setTaskViewPreference(userId, body.taskView);
    if (hasZone) await Db.setSecondaryTimezonePreference(userId, zone);
    if (hasListToggle) await Db.setTaskListInCalendar(userId, toggle.calendarId, toggle.shown);
    res.json(await readPreferences(userId));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
