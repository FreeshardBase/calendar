'use strict';

const Db = require('../db');

/**
 * Compare two event objects (old and new) and return a diff object of changed fields.
 * Diff format: { [field]: { old: value, new: value } }
 */
function computeEventDiff(oldEvent, newEvent) {
  const diff = {};
  if (!oldEvent || !newEvent) return diff;

  const keys = ['title', 'start', 'end', 'allDay', 'location', 'description', 'categories', 'recurrence', 'status'];

  for (const key of keys) {
    const oldVal = oldEvent[key];
    const newVal = newEvent[key];

    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      const oldArr = Array.isArray(oldVal) ? oldVal.slice().sort() : [];
      const newArr = Array.isArray(newVal) ? newVal.slice().sort() : [];
      if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) {
        diff[key] = { old: oldVal || null, new: newVal || null };
      }
    } else if (oldVal !== newVal) {
      if (oldVal !== undefined || newVal !== undefined) {
        diff[key] = { old: oldVal !== undefined ? oldVal : null, new: newVal !== undefined ? newVal : null };
      }
    }
  }

  return diff;
}

/**
 * Log an event change in the history database.
 */
async function logEventChange({ eventUid, calendarId, userId, action, oldEvent, newEvent, snapshotIcs }) {
  if (!eventUid || !calendarId || !userId || !action) {
    return null;
  }

  let changes = null;
  if (action === 'CREATE' && newEvent) {
    changes = { title: { new: newEvent.title || null }, start: { new: newEvent.start || null } };
  } else if (action === 'UPDATE' && oldEvent && newEvent) {
    changes = computeEventDiff(oldEvent, newEvent);
  } else if (action === 'DELETE' && oldEvent) {
    changes = { title: { old: oldEvent.title || null } };
  } else if (action === 'RSVP' && newEvent) {
    changes = { rsvp: { new: newEvent.status || newEvent.partstat || 'RESPONDED' } };
  }

  return Db.recordEventHistory({
    eventUid,
    calendarId,
    userId,
    action,
    changes,
    snapshotIcs
  });
}

module.exports = {
  computeEventDiff,
  logEventChange
};
