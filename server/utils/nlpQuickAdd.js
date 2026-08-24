'use strict';

/**
 * Natural Language Parser for Quick-Add Events & Tasks (Issue #14)
 */

function parseQuickAdd(inputText, referenceDate = new Date()) {
  if (!inputText || typeof inputText !== 'string') {
    throw new Error('Input text must be a non-empty string');
  }

  let text = inputText.trim();
  const ref = new Date(referenceDate);
  if (isNaN(ref.getTime())) {
    throw new Error('Invalid reference date');
  }

  let type = 'event';
  let title = text;

  // Use UTC base date for consistent date arithmetic without timezone shifts
  let baseDate = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));

  let startTime = null;
  let endTime = null;
  let allDay = true;
  let location = null;
  let recurrence = null;

  // 1. Detect Task vs Event
  const taskPrefixRegex = /^(?:todo:|task:|aufgabe:)\s*/i;
  const taskVerbRegex = /^(?:buy|kaufen|einkaufen|erledigen|check)\s+/i;
  const taskTagRegex = /\[(?:task|todo)\]|\((?:task|todo)\)/i;

  if (taskPrefixRegex.test(text)) {
    type = 'task';
    text = text.replace(taskPrefixRegex, '');
  } else if (taskTagRegex.test(text)) {
    type = 'task';
    text = text.replace(taskTagRegex, '');
  } else if (taskVerbRegex.test(text)) {
    type = 'task';
  }

  // 2. Detect Recurrence (Explicit recurring phrases)
  const recurrenceMap = [
    { regex: /(?:^|\s)(?:jeden montag|every monday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=MO' },
    { regex: /(?:^|\s)(?:jeden dienstag|every tuesday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=TU' },
    { regex: /(?:^|\s)(?:jeden mittwoch|every wednesday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=WE' },
    { regex: /(?:^|\s)(?:jeden donnerstag|every thursday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=TH' },
    { regex: /(?:^|\s)(?:jeden freitag|every friday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=FR' },
    { regex: /(?:^|\s)(?:jeden samstag|every saturday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=SA' },
    { regex: /(?:^|\s)(?:jeden sonntag|every sunday)(?=\s|$)/i, rule: 'FREQ=WEEKLY;BYDAY=SU' },
    { regex: /(?:^|\s)(?:jeden tag|every day)(?=\s|$)/i, rule: 'FREQ=DAILY' },
    { regex: /(?:^|\s)(?:jede woche|every week)(?=\s|$)/i, rule: 'FREQ=WEEKLY' },
    { regex: /(?:^|\s)(?:jeden monat|every month)(?=\s|$)/i, rule: 'FREQ=MONTHLY' }
  ];

  for (const item of recurrenceMap) {
    if (item.regex.test(text)) {
      recurrence = item.rule;
      text = text.replace(item.regex, ' ');
      break;
    }
  }

  // 3. Location Extraction
  const locationRegex = /(?:^|\s)(?:at|im|in der|in)\s+([A-Za-z0-9_ -]+)$/i;
  const locationMidRegex = /(?:^|\s)(?:at|im|in der|in)\s+([A-Za-z0-9_ -]+?)\s+(?=(?:tomorrow|morgen|today|heute|übermorgen|on|am|next|nächste|nächsten|\d{1,2}:\d{2}|\d{1,2}\s*uhr|\d{1,2}(?:am|pm))\b)/i;

  let locMatch = text.match(locationMidRegex) || text.match(locationRegex);
  if (locMatch) {
    const candidate = locMatch[1].trim();
    if (!/^(?:\d{1,2}:\d{2}|\d{1,2}\s*uhr|\d{1,2}(?:am|pm)|tomorrow|morgen|today|heute|übermorgen)$/i.test(candidate)) {
      location = candidate;
      text = text.replace(locMatch[0], ' ');
    }
  }

  // 4. Date Parsing
  let dateFound = false;

  // Relative dates (using space/boundary whitespace matching for non-ASCII)
  if (/(?:^|\s)übermorgen(?:\s|$)/i.test(text)) {
    baseDate.setUTCDate(baseDate.getUTCDate() + 2);
    text = text.replace(/(?:^|\s)übermorgen(?:\s|$)/i, ' ');
    dateFound = true;
  } else if (/(?:^|\s)(?:tomorrow|morgen)(?:\s|$)/i.test(text)) {
    baseDate.setUTCDate(baseDate.getUTCDate() + 1);
    text = text.replace(/(?:^|\s)(?:tomorrow|morgen)(?:\s|$)/i, ' ');
    dateFound = true;
  } else if (/(?:^|\s)(?:today|heute)(?:\s|$)/i.test(text)) {
    text = text.replace(/(?:^|\s)(?:today|heute)(?:\s|$)/i, ' ');
    dateFound = true;
  }

  // Explicit dates: YYYY-MM-DD
  const isoDateMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!dateFound && isoDateMatch) {
    const year = parseInt(isoDateMatch[1], 10);
    const month = parseInt(isoDateMatch[2], 10) - 1;
    const day = parseInt(isoDateMatch[3], 10);
    baseDate = new Date(Date.UTC(year, month, day));
    text = text.replace(isoDateMatch[0], ' ');
    dateFound = true;
  }

  // Explicit dates: DD.MM.YYYY or DD.MM.
  const deDateMatch = text.match(/\b(\d{1,2})\.(\d{1,2})\.(?:(\d{4})\b)?/);
  if (!dateFound && deDateMatch) {
    const day = parseInt(deDateMatch[1], 10);
    const month = parseInt(deDateMatch[2], 10) - 1;
    const year = deDateMatch[3] ? parseInt(deDateMatch[3], 10) : ref.getUTCFullYear();
    baseDate = new Date(Date.UTC(year, month, day));
    text = text.replace(deDateMatch[0], ' ');
    dateFound = true;
  }

  // Weekdays: next Friday / nächsten Freitag / am Dienstag / on Monday
  const weekdayMap = {
    sunday: 0, sonntag: 0,
    monday: 1, montag: 1,
    tuesday: 2, dienstag: 2,
    wednesday: 3, mittwoch: 3,
    thursday: 4, donnerstag: 4,
    friday: 5, freitag: 5,
    saturday: 6, samstag: 6
  };

  const weekdayRegex = /(?:^|\s)(?:on|am|next|nächsten|nächste)?\s*(sunday|sonntag|monday|montag|tuesday|dienstag|wednesday|mittwoch|thursday|donnerstag|friday|freitag|saturday|samstag)(?:\s|$)/i;
  const wdMatch = text.match(weekdayRegex);
  if (!dateFound && wdMatch) {
    const targetDay = weekdayMap[wdMatch[1].toLowerCase()];
    const currentDay = baseDate.getUTCDay();
    let diff = (targetDay - currentDay + 7) % 7;
    if (diff === 0) diff = 7;
    baseDate.setUTCDate(baseDate.getUTCDate() + diff);
    text = text.replace(wdMatch[0], ' ');
    dateFound = true;
  }

  // 5. Time Parsing
  const timeRangeRegex = /\b(\d{1,2}:\d{2})\s*(?:to|bis|-)\s*(\d{1,2}:\d{2})\b/i;
  const rangeMatch = text.match(timeRangeRegex);
  if (rangeMatch) {
    startTime = rangeMatch[1].padStart(5, '0');
    endTime = rangeMatch[2].padStart(5, '0');
    allDay = false;
    text = text.replace(rangeMatch[0], ' ');
  } else {
    const amPmRegex = /(?:^|\s)(?:at|um)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s|$)/i;
    const amPmMatch = text.match(amPmRegex);
    if (amPmMatch) {
      let hrs = parseInt(amPmMatch[1], 10);
      const mins = amPmMatch[2] || '00';
      const mer = amPmMatch[3].toLowerCase();
      if (mer === 'pm' && hrs < 12) hrs += 12;
      if (mer === 'am' && hrs === 12) hrs = 0;
      startTime = `${String(hrs).padStart(2, '0')}:${mins}`;
      endTime = `${String((hrs + 1) % 24).padStart(2, '0')}:${mins}`;
      allDay = false;
      text = text.replace(amPmMatch[0], ' ');
    } else {
      const timeRegex = /(?:^|\s)(?:at|um)?\s*(\d{1,2}:\d{2})\s*(?:uhr)?(?:\s|$)/i;
      const timeMatch = text.match(timeRegex);
      if (timeMatch) {
        startTime = timeMatch[1].padStart(5, '0');
        const [hStr, mStr] = startTime.split(':');
        const h = parseInt(hStr, 10);
        endTime = `${String((h + 1) % 24).padStart(2, '0')}:${mStr}`;
        allDay = false;
        text = text.replace(timeMatch[0], ' ');
      }
    }
  }

  // 6. Clean Title
  title = text
    .replace(/(?:^|\s)(?:on|am|um|at|in|uhr)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) {
    title = inputText.trim();
  }

  const yyyy = baseDate.getUTCFullYear();
  const mm = String(baseDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(baseDate.getUTCDate()).padStart(2, '0');
  const startDate = `${yyyy}-${mm}-${dd}`;

  let endDate = startDate;
  if (!allDay && startTime && endTime && endTime < startTime) {
    const nextDay = new Date(baseDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nYyyy = nextDay.getUTCFullYear();
    const nM = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
    const nD = String(nextDay.getUTCDate()).padStart(2, '0');
    endDate = `${nYyyy}-${nM}-${nD}`;
  }

  return {
    title,
    type,
    startDate,
    startTime,
    endDate,
    endTime,
    allDay,
    location,
    recurrence,
    parsed: true
  };
}

module.exports = { parseQuickAdd };
