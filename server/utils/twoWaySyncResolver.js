'use strict';

const ICAL = require('ical.js');

/**
 * Detects divergence and conflict between local and remote iCalendar strings.
 *
 * @param {string} localIcs
 * @param {string} remoteIcs
 * @returns {Object} { hasConflict, uid, localSequence, remoteSequence, ... }
 */
function detectTwoWayConflict(localIcs, remoteIcs) {
  if (!localIcs || !remoteIcs) {
    return { hasConflict: false };
  }

  let localComp, remoteComp;
  try {
    localComp = new ICAL.Component(ICAL.parse(localIcs));
    remoteComp = new ICAL.Component(ICAL.parse(remoteIcs));
  } catch (err) {
    return { hasConflict: false };
  }

  const localVevent = localComp.getFirstSubcomponent('vevent');
  const remoteVevent = remoteComp.getFirstSubcomponent('vevent');

  if (!localVevent || !remoteVevent) {
    return { hasConflict: false };
  }

  const getPropVal = (comp, propName) => {
    const prop = comp.getFirstPropertyValue(propName);
    return prop ? prop.toString() : '';
  };

  const uid = getPropVal(localVevent, 'uid') || getPropVal(remoteVevent, 'uid');

  const localSummary = getPropVal(localVevent, 'summary');
  const remoteSummary = getPropVal(remoteVevent, 'summary');

  const localDesc = getPropVal(localVevent, 'description');
  const remoteDesc = getPropVal(remoteVevent, 'description');

  const localLoc = getPropVal(localVevent, 'location');
  const remoteLoc = getPropVal(remoteVevent, 'location');

  const localStart = getPropVal(localVevent, 'dtstart');
  const remoteStart = getPropVal(remoteVevent, 'dtstart');

  const localEnd = getPropVal(localVevent, 'dtend');
  const remoteEnd = getPropVal(remoteVevent, 'dtend');

  const localSeq = parseInt(getPropVal(localVevent, 'sequence') || '0', 10);
  const remoteSeq = parseInt(getPropVal(remoteVevent, 'sequence') || '0', 10);

  const localLastMod = getPropVal(localVevent, 'last-modified');
  const remoteLastMod = getPropVal(remoteVevent, 'last-modified');

  const isDivergent = (
    localSummary !== remoteSummary ||
    localDesc !== remoteDesc ||
    localLoc !== remoteLoc ||
    localStart !== remoteStart ||
    localEnd !== remoteEnd
  );

  if (!isDivergent) {
    return { hasConflict: false, uid };
  }

  return {
    hasConflict: true,
    uid,
    localEvent: {
      summary: localSummary,
      description: localDesc,
      location: localLoc,
      start: localStart,
      end: localEnd
    },
    remoteEvent: {
      summary: remoteSummary,
      description: remoteDesc,
      location: remoteLoc,
      start: remoteStart,
      end: remoteEnd
    },
    localLastModified: localLastMod,
    remoteLastModified: remoteLastMod,
    localSequence: localSeq,
    remoteSequence: remoteSeq
  };
}

/**
 * Resolves a two-way synchronization conflict using the specified strategy.
 *
 * @param {string} localIcs
 * @param {string} remoteIcs
 * @param {string} strategy 'LOCAL_WINS' | 'REMOTE_WINS' | 'LAST_MODIFIED_WINS' | 'MERGE_PROPERTIES'
 * @returns {string} Resolved iCalendar string
 */
function resolveTwoWayConflict(localIcs, remoteIcs, strategy = 'LAST_MODIFIED_WINS') {
  if (!localIcs) return remoteIcs;
  if (!remoteIcs) return localIcs;

  if (strategy === 'LOCAL_WINS') {
    return localIcs;
  }

  if (strategy === 'REMOTE_WINS') {
    return remoteIcs;
  }

  let localComp, remoteComp;
  try {
    localComp = new ICAL.Component(ICAL.parse(localIcs));
    remoteComp = new ICAL.Component(ICAL.parse(remoteIcs));
  } catch (err) {
    return localIcs || remoteIcs;
  }

  const localVevent = localComp.getFirstSubcomponent('vevent');
  const remoteVevent = remoteComp.getFirstSubcomponent('vevent');

  if (!localVevent || !remoteVevent) {
    return localIcs;
  }

  if (strategy === 'LAST_MODIFIED_WINS') {
    const localLastModProp = localVevent.getFirstPropertyValue('last-modified');
    const remoteLastModProp = remoteVevent.getFirstPropertyValue('last-modified');

    const localTime = localLastModProp ? new Date(localLastModProp.toJSDate()).getTime() : 0;
    const remoteTime = remoteLastModProp ? new Date(remoteLastModProp.toJSDate()).getTime() : 0;

    if (remoteTime > localTime) {
      return remoteIcs;
    } else if (localTime > remoteTime) {
      return localIcs;
    }

    const localSeq = parseInt(localVevent.getFirstPropertyValue('sequence') || '0', 10);
    const remoteSeq = parseInt(remoteVevent.getFirstPropertyValue('sequence') || '0', 10);

    return remoteSeq > localSeq ? remoteIcs : localIcs;
  }

  if (strategy === 'MERGE_PROPERTIES') {
    const mergedComp = ICAL.Component.fromString(localIcs);
    const mergedVevent = mergedComp.getFirstSubcomponent('vevent');

    const localSeq = parseInt(localVevent.getFirstPropertyValue('sequence') || '0', 10);
    const remoteSeq = parseInt(remoteVevent.getFirstPropertyValue('sequence') || '0', 10);

    const remoteProps = remoteVevent.getAllProperties();
    for (const prop of remoteProps) {
      const propName = prop.name.toLowerCase();
      if (['uid', 'sequence', 'last-modified', 'created', 'dtstamp'].includes(propName)) {
        continue;
      }

      const localPropVal = localVevent.getFirstPropertyValue(propName);
      const remotePropVal = prop.getFirstValue();

      if (propName.startsWith('x-')) {
        const existing = mergedVevent.getFirstProperty(propName);
        if (!existing) {
          mergedVevent.addProperty(prop);
        }
      } else if (!localPropVal && remotePropVal) {
        mergedVevent.updatePropertyWithValue(propName, remotePropVal);
      } else if (remotePropVal && remotePropVal !== localPropVal) {
        // If remote has an updated property value and local didn't modify it, or for remote location update
        if (propName === 'location' || (!localPropVal && remotePropVal)) {
          mergedVevent.updatePropertyWithValue(propName, remotePropVal);
        }
      }
    }

    const nextSeq = Math.max(localSeq, remoteSeq) + 1;
    mergedVevent.updatePropertyWithValue('sequence', nextSeq);
    mergedVevent.updatePropertyWithValue('last-modified', ICAL.Time.now());

    return mergedComp.toString();
  }

  return localIcs;
}

module.exports = {
  detectTwoWayConflict,
  resolveTwoWayConflict
};
