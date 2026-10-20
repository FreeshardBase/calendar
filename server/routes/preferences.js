'use strict';

// Issue #498: per-user UI choices that follow the user to every browser.
// Issue #509: the week/day grid's second time zone is one of them (the user's calendar setting, #355).
// Issue #518: so is, per task list, whether its due tasks show in the calendar views.
// Issue #517: so are the ISO week numbers in the month/week grid and the mini month.
// Issue #521: so is the Jitsi base URL behind "Videokonferenz hinzufügen" (null = off).
// Issue #625: so are week start, 12/24 h, default duration/calendar/reminder and the time zone.
// Issue #626: so is the UI language; #627 adds Deutsch (Sie) as 'de-formal'.

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { userError } = require('../utils/errorSanitizer');

const TASK_VIEWS = ['list', 'kanban'];
const MAX_BASE_URL = 512;

// A plain http(s) server address (optionally with a path) without trailing slash, or null for anything
// else: no credentials, query or fragment, since a random room name is appended to it.
function conferenceBaseUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_BASE_URL || /[?#\s]/.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

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

const MAX_DURATION = 24 * 60;
const MAX_REMINDER = 4 * 7 * 24 * 60;
const isMinutes = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// #625: each returns the value to store, or undefined for one that is not acceptable. null = not chosen.
const CALENDAR_PREFERENCES = {
  weekStart: v => (v === null || ['mon', 'sun', 'sat'].includes(v) ? v : undefined),
  timeFormat: v => (v === null || ['12h', '24h'].includes(v) ? v : undefined),
  defaultDuration: v => (isMinutes(v, 5, MAX_DURATION) ? v : undefined),
  defaultCalendarId: v => (v === null || (typeof v === 'string' && v.length > 0 && v.length <= 1024) ? v : undefined),
  defaultReminder: v => (v === null || isMinutes(v, 0, MAX_REMINDER) ? v : undefined),
  timeZone: v => (v === null ? null : ianaZone(v) ?? undefined),
  language: v => (v === null || ['de', 'de-formal', 'en'].includes(v) ? v : undefined),
};
// #628: a refused value is answered as an error code the UI translates (errorSanitizer.js).
const invalid = name => userError('INVALID_PREFERENCE', 400, { name });

async function readPreferences(userId) {
  return {
    taskView: await Db.getTaskViewPreference(userId),
    secondaryTimezone: await Db.getSecondaryTimezonePreference(userId),
    tasksHiddenInCalendar: await Db.getTasksHiddenInCalendar(userId),
    showWeekNumbers: await Db.getWeekNumbersPreference(userId),
    conferenceBaseUrl: await Db.getConferenceBaseUrlPreference(userId),
    ...await Db.getCalendarPreferences(userId),
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
//   taskListInCalendar?: { calendarId: '<id>', shown: boolean }, showWeekNumbers?: boolean,
//   conferenceBaseUrl?: '<http(s) URL>' | null, plus the CALENDAR_PREFERENCES keys (#625) }
router.put('/', async (req, res, next) => {
  const body = req.body || {};
  const hasTaskView = Object.prototype.hasOwnProperty.call(body, 'taskView');
  const hasZone = Object.prototype.hasOwnProperty.call(body, 'secondaryTimezone');
  const hasListToggle = Object.prototype.hasOwnProperty.call(body, 'taskListInCalendar');
  const hasWeekNumbers = Object.prototype.hasOwnProperty.call(body, 'showWeekNumbers');
  const hasConference = Object.prototype.hasOwnProperty.call(body, 'conferenceBaseUrl');
  const calendarPrefs = {};
  for (const key of Object.keys(CALENDAR_PREFERENCES)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = CALENDAR_PREFERENCES[key](body[key]);
    if (value === undefined) return next(key === 'timeZone' ? userError('INVALID_TIME_ZONE', 400) : invalid(key));
    calendarPrefs[key] = value;
  }
  const hasCalendarPrefs = Object.keys(calendarPrefs).length > 0;
  if (!hasTaskView && !hasZone && !hasListToggle && !hasWeekNumbers && !hasConference && !hasCalendarPrefs) {
    return next(userError('NO_PREFERENCE', 400));
  }
  const conference = hasConference && body.conferenceBaseUrl !== null ? conferenceBaseUrl(body.conferenceBaseUrl) : null;
  if (hasConference && body.conferenceBaseUrl !== null && conference === null) {
    return next(userError('INVALID_CONFERENCE_URL', 400));
  }
  if (hasWeekNumbers && typeof body.showWeekNumbers !== 'boolean') return next(invalid('showWeekNumbers'));
  if (hasTaskView && !TASK_VIEWS.includes(body.taskView)) return next(invalid('taskView'));
  const zone = hasZone && body.secondaryTimezone !== null ? ianaZone(body.secondaryTimezone) : null;
  if (hasZone && body.secondaryTimezone !== null && zone === null) {
    return next(userError('INVALID_TIME_ZONE', 400));
  }
  const toggle = body.taskListInCalendar;
  if (hasListToggle && !(toggle && typeof toggle.calendarId === 'string' && toggle.calendarId.length > 0
    && toggle.calendarId.length <= 1024 && typeof toggle.shown === 'boolean')) {
    return next(invalid('taskListInCalendar'));
  }
  try {
    const userId = req.session.userId;
    if (hasTaskView) await Db.setTaskViewPreference(userId, body.taskView);
    if (hasZone) await Db.setSecondaryTimezonePreference(userId, zone);
    if (hasListToggle) await Db.setTaskListInCalendar(userId, toggle.calendarId, toggle.shown);
    if (hasWeekNumbers) await Db.setWeekNumbersPreference(userId, body.showWeekNumbers);
    if (hasConference) await Db.setConferenceBaseUrlPreference(userId, conference);
    if (hasCalendarPrefs) await Db.setCalendarPreferences(userId, calendarPrefs);
    res.json(await readPreferences(userId));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
