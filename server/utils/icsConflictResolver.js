'use strict';

const ICAL = require('ical.js');
const crypto = require('crypto');

/**
 * Parses raw ICAL text and checks each VEVENT against existing calendar events for duplicates,
 * modified conflicts, and time overlaps.
 *
 * @param {string} icsText Raw iCalendar string
 * @param {Array<Object>} existingEvents Array of existing event objects
 * @returns {Object} { summary, conflicts }
 */
function detectICSConflicts(icsText, existingEvents = []) {
  if (!icsText || typeof icsText !== 'string') {
    throw new Error('icsText string is required');
  }

  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(icsText));
  } catch (err) {
    const invalid = new Error('Ungültige ICS-Datei: ' + err.message);
    invalid.userCode = 'INVALID_ICS';
    invalid.userMessage ='Ungültige ICS-Datei. Die Datei konnte nicht gelesen werden.';
    invalid.status = 400;
    throw invalid;
  }

  const vevents = comp.getAllSubcomponents('vevent');
  const vtimezones = comp.getAllSubcomponents('vtimezone');
  const conflicts = [];
  let newCount = 0;
  let duplicateCount = 0;
  let conflictCount = 0;

  for (const vevent of vevents) {
    const uidProp = vevent.getFirstPropertyValue('uid');
    const uid = uidProp ? uidProp.toString() : crypto.randomUUID();
    const title = vevent.getFirstPropertyValue('summary') ? vevent.getFirstPropertyValue('summary').toString() : '';
    const description = vevent.getFirstPropertyValue('description') ? vevent.getFirstPropertyValue('description').toString() : '';
    const location = vevent.getFirstPropertyValue('location') ? vevent.getFirstPropertyValue('location').toString() : '';

    const dtstartProp = vevent.getFirstPropertyValue('dtstart');
    const dtendProp = vevent.getFirstPropertyValue('dtend');
    const startIso = dtstartProp ? dtstartProp.toJSDate().toISOString() : new Date().toISOString();
    const endIso = dtendProp ? dtendProp.toJSDate().toISOString() : new Date(Date.now() + 3600000).toISOString();

    const importedEvent = {
      uid,
      title,
      description,
      location,
      start: startIso,
      end: endIso
    };

    // 1. Direct UID match in existing events
    const matchByUid = existingEvents.find(e => e.uid === uid);

    if (matchByUid) {
      const isExact = (
        (matchByUid.title || '') === title &&
        (matchByUid.description || '') === description &&
        (matchByUid.location || '') === location &&
        new Date(matchByUid.start).getTime() === new Date(startIso).getTime() &&
        new Date(matchByUid.end).getTime() === new Date(endIso).getTime()
      );

      if (isExact) {
        duplicateCount++;
        conflicts.push({
          uid,
          title,
          start: startIso,
          end: endIso,
          location,
          description,
          status: 'EXACT_DUPLICATE',
          existingEvent: matchByUid,
          importedEvent,
          veventComp: vevent,
          suggestedAction: 'SKIP'
        });
      } else {
        conflictCount++;
        conflicts.push({
          uid,
          title,
          start: startIso,
          end: endIso,
          location,
          description,
          status: 'MODIFIED_CONFLICT',
          existingEvent: matchByUid,
          importedEvent,
          veventComp: vevent,
          suggestedAction: 'OVERWRITE'
        });
      }
      continue;
    }

    // 2. Exact match by Title + Start + End
    const matchByContent = existingEvents.find(e =>
      (e.title || '') === title &&
      new Date(e.start).getTime() === new Date(startIso).getTime() &&
      new Date(e.end).getTime() === new Date(endIso).getTime()
    );

    if (matchByContent) {
      duplicateCount++;
      conflicts.push({
        uid,
        title,
        start: startIso,
        end: endIso,
        location,
        description,
        status: 'EXACT_DUPLICATE',
        existingEvent: matchByContent,
        importedEvent,
        veventComp: vevent,
        suggestedAction: 'SKIP'
      });
      continue;
    }

    // 3. Time overlap check
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const overlapEvent = existingEvents.find(e => {
      const eStart = new Date(e.start).getTime();
      const eEnd = new Date(e.end).getTime();
      return startMs < eEnd && endMs > eStart;
    });

    if (overlapEvent) {
      conflictCount++;
      conflicts.push({
        uid,
        title,
        start: startIso,
        end: endIso,
        location,
        description,
        status: 'TIME_OVERLAP',
        existingEvent: overlapEvent,
        importedEvent,
        veventComp: vevent,
        suggestedAction: 'CREATE_NEW'
      });
      continue;
    }

    // 4. Completely new event
    newCount++;
    conflicts.push({
      uid,
      title,
      start: startIso,
      end: endIso,
      location,
      description,
      status: 'NEW',
      existingEvent: null,
      importedEvent,
      veventComp: vevent,
      suggestedAction: 'CREATE_NEW'
    });
  }

  return {
    summary: {
      total: vevents.length,
      newCount,
      duplicateCount,
      conflictCount
    },
    vtimezones,
    conflicts
  };
}

/**
 * Resolves imported events based on action preferences per UID or default strategy.
 *
 * @param {string} icsText Raw iCalendar string
 * @param {Array<Object>} existingEvents Existing events list
 * @param {Object|string} resolutions Map of uid -> 'SKIP'|'OVERWRITE'|'CREATE_NEW' or global string strategy
 * @returns {Array<Object>} List of resolved event objects ready for persistence
 */
function resolveICSImport(icsText, existingEvents = [], resolutions = {}) {
  const { conflicts, vtimezones } = detectICSConflicts(icsText, existingEvents);
  const resolved = [];

  for (const item of conflicts) {
    let action;
    if (typeof resolutions === 'string') {
      if (resolutions === 'SKIP') {
        action = (item.status === 'EXACT_DUPLICATE' || item.status === 'MODIFIED_CONFLICT') ? 'SKIP' : 'CREATE_NEW';
      } else {
        action = (item.status === 'NEW' || item.status === 'TIME_OVERLAP') ? 'CREATE_NEW' : resolutions;
      }
    } else if (resolutions && resolutions[item.uid]) {
      action = resolutions[item.uid];
    } else {
      action = item.suggestedAction || 'CREATE_NEW';
    }

    if (action === 'SKIP') {
      continue;
    }

    let finalUid = item.uid;
    if (action === 'CREATE_NEW' && (item.status !== 'NEW' || (resolutions && typeof resolutions === 'object' && resolutions[item.uid] === 'CREATE_NEW'))) {
      finalUid = `imported-${crypto.randomUUID()}`;
    }

    const veventCopy = ICAL.Component.fromString(item.veventComp.toString());
    veventCopy.updatePropertyWithValue('uid', finalUid);

    resolved.push({
      originalUid: item.uid,
      uid: finalUid,
      action,
      veventComp: veventCopy,
      vtimezones,
      event: {
        ...item.importedEvent,
        uid: finalUid
      }
    });
  }

  return resolved;
}

module.exports = {
  detectICSConflicts,
  resolveICSImport
};
