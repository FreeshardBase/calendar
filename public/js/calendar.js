/**
 * calendar.js — Calendar rendering engine.
 * Renders month, week, day, and agenda views.
 * Handles time-grid click-to-create on the 15-minute slot; drag and drop in the day/week (#574) and
 * month view (#575) and drag to create (#576) live in eventDrag.js.
 */

import { store, visibleCalendars, calendarById } from './store.js';
import { zoneAbbreviation, zoneOffsetLabel, timeInZone, localTimeZone } from './timezones.js';
import { enableEventDrag, deferRenderWhileDragging } from './eventDrag.js';
import { dateFormat, formatDate, formatTime, formatNumber, weekdayName, startOfWeek, weekDays, allDayDate, localDateString } from './locale.js';

const monthYear = date => formatDate(date, { month: 'long', year: 'numeric' });

const HOUR_H = 60; // px per hour in time grid
const DAY_START = 0; // render from hour 0
const TOTAL_HOURS = 24;

let currentTimeLineTimer = null;

export function clearCurrentTimeLineTimer() {
  if (currentTimeLineTimer) {
    clearInterval(currentTimeLineTimer);
    currentTimeLineTimer = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderView(container, events, view, currentDate, callbacks) {
  if (deferRenderWhileDragging(() => renderView(container, events, view, currentDate, callbacks))) return;
  clearCurrentTimeLineTimer();
  container.innerHTML = '';
  switch (view) {
    case 'month':  renderMonth(container, events, currentDate, callbacks); break;
    case 'week':   renderWeek(container, events, currentDate, callbacks, 'week');  break;
    case 'workweek': renderWeek(container, events, currentDate, callbacks, 'workweek'); break;
    case '3day':   renderWeek(container, events, currentDate, callbacks, '3day'); break;
    case 'day':    renderDay(container, events, currentDate, callbacks);   break;
    case 'agenda': renderAgenda(container, events, currentDate, callbacks);break;
  }
}

export function getToolbarTitle(view, date) {
  switch (view) {
    case 'month':  return monthYear(date);
    case 'week':   return rangeTitle(startOfWeek(date), 7);
    case 'workweek': return rangeTitle(startOfWeek(date, 1), 5);
    case '3day':   return rangeTitle(dayStart(date), 3);
    case 'day':    return `${weekdayName(date)}, ${formatDate(date, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    case 'agenda': return monthYear(date);
    // #510: the list chooses its own range in the view.
    case 'list':   return 'Liste';
  }
}

export function navigate(view, date, direction) {
  const d = new Date(date);
  switch (view) {
    case 'month':
    case 'agenda': {
      // Clamp day to last day of target month to prevent JS Date overflow
      // e.g. Jan 31 + 1 month must land in February, not March.
      const targetMonth = d.getMonth() + direction;
      const daysInTarget = new Date(d.getFullYear(), targetMonth + 1, 0).getDate();
      d.setDate(Math.min(d.getDate(), daysInTarget));
      d.setMonth(targetMonth);
      break;
    }
    case 'week':
    case 'workweek': d.setDate(d.getDate() + 7 * direction); break;
    case '3day':     d.setDate(d.getDate() + 3 * direction);  break;
    case 'day':      d.setDate(d.getDate() + direction);      break;
  }
  return d;
}

export function getDateRange(view, date) {
  let start, end;
  switch (view) {
    case 'month': {
      start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
      end = new Date(start);
      end.setDate(start.getDate() + 41); // 42 days total (6 full weeks)
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'week': {
      start = startOfWeek(date);
      end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
      break;
    }
    case 'workweek': {
      start = startOfWeek(date, 1);
      end   = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23, 59, 59, 999);
      break;
    }
    // #351: the phone's view, three days from the current one.
    case '3day': {
      start = dayStart(date);
      end   = new Date(start); end.setDate(start.getDate() + 2); end.setHours(23, 59, 59, 999);
      break;
    }
    case 'day': {
      start = new Date(date); start.setHours(0, 0, 0, 0);
      end   = new Date(date); end.setHours(23, 59, 59, 999);
      break;
    }
    case 'agenda': {
      start = new Date(date); start.setDate(1); start.setHours(0, 0, 0, 0);
      end   = new Date(date); end.setMonth(end.getMonth() + 3); end.setHours(23, 59, 59, 999);
      break;
    }
    default: {
      start = new Date(date); start.setDate(1); start.setHours(0, 0, 0, 0);
      end   = new Date(date); end.setMonth(end.getMonth() + 1); end.setHours(23, 59, 59, 999);
      break;
    }
  }
  return { start, end };
}

// ── Week numbers (#517) ───────────────────────────────────────────────────────

// ISO 8601 week number of the week containing `date` (weeks start on Monday, week 1 holds 4 January).
export function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7); // the Thursday of that week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// The ISO week a displayed row of seven days stands for: the week holding most of its days, i.e.
// the week of its middle day. With weeks starting on Monday that is the row's own ISO week.
function rowWeekNumber(rowStart) {
  const mid = new Date(rowStart);
  mid.setDate(mid.getDate() + 3);
  return isoWeekNumber(mid);
}

// ── Mini Calendar ─────────────────────────────────────────────────────────────

// Days of `year`/`month` (day numbers) on which an event lies, all days of a multi-day event included.
function eventDaysInMonth(events, year, month) {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 1);
  const days = new Set();
  for (const ev of events) {
    if (!ev.start) continue;
    const start = new Date(ev.start);
    // The end is exclusive; an event without an end, or ending at its start, covers its start day.
    const end = ev.end && new Date(ev.end) > start ? new Date(ev.end) : new Date(start.getTime() + 1);
    const d = new Date(Math.max(start, monthStart));
    d.setHours(0, 0, 0, 0);
    for (; d < end && d < monthEnd; d.setDate(d.getDate() + 1)) {
      if (d >= monthStart) days.add(d.getDate());
    }
  }
  return days;
}

// The day to focus once the mini month shows it, after a keyboard move left the displayed month.
let pendingMiniFocus = null;

// Keys of the mini month's day grid, as in a date-picker grid: arrows move by day and week,
// Home/End to the row's ends, Page Up/Down by month.
function miniKeyTarget(key, date) {
  const d = new Date(date);
  switch (key) {
    case 'ArrowLeft':  d.setDate(d.getDate() - 1); return d;
    case 'ArrowRight': d.setDate(d.getDate() + 1); return d;
    case 'ArrowUp':    d.setDate(d.getDate() - 7); return d;
    case 'ArrowDown':  d.setDate(d.getDate() + 7); return d;
    case 'Home':       return startOfWeek(d);
    case 'End':        { const ws = startOfWeek(d); ws.setDate(ws.getDate() + 6); return ws; }
    case 'PageUp':     return navigate('month', d, -1);
    case 'PageDown':   return navigate('month', d, +1);
    default:           return null;
  }
}

// options.range: the main view's { start, end }, highlighted (#517);
// options.showWeekNumbers: a column of ISO week numbers (#517).
export function renderMiniCalendar(container, currentDate, events, onDayClick, options = {}) {
  const { range = null, showWeekNumbers = false } = options;
  const today = new Date(); today.setHours(0,0,0,0);
  const month = currentDate.getMonth();
  const year  = currentDate.getFullYear();

  const eventDays = eventDaysInMonth(events, year, month);

  const first = new Date(year, month, 1);
  const gridStart = startOfWeek(first);
  const startDay = Math.round((first - gridStart) / 86400000);

  let html = `
    <div class="mini-cal-header">
      <span class="mini-cal-title">${formatDate(first, { month: 'short', year: 'numeric' })}</span>
      <div class="mini-cal-nav">
        <button data-mini-prev aria-label="Vorheriger Monat" title="Vorheriger Monat">‹</button>
        <button data-mini-next aria-label="Nächster Monat" title="Nächster Monat">›</button>
      </div>
    </div>
    <div class="mini-cal-grid${showWeekNumbers ? ' with-weeks' : ''}">
      ${showWeekNumbers ? '<div class="mini-cal-dow" aria-hidden="true">KW</div>' : ''}
      ${weekDays(gridStart).map(d => `<div class="mini-cal-dow">${weekdayName(d)}</div>`).join('')}
  `;

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < 42; i++) {
    const col = i - startDay;
    if (showWeekNumbers && i % 7 === 0) {
      const week = rowWeekNumber(new Date(year, month, col + 1));
      html += `<div class="mini-cal-week" aria-label="Kalenderwoche ${week}">${week}</div>`;
    }
    if (col < 0 || col >= daysInMonth) {
      html += `<div class="mini-cal-day other-month"></div>`;
    } else {
      const d = new Date(year, month, col + 1);
      const isToday    = sameDay(d, today);
      const isSelected = sameDay(d, currentDate);
      const hasEvents  = eventDays.has(col + 1);
      const inRange    = range !== null && d >= range.start && d <= range.end;
      const label = longDateLabel(d) + (hasEvents ? ', mit Terminen' : '');
      // One tab stop for the grid (the selected day); the arrow keys move between the days.
      html += `<div class="mini-cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${hasEvents ? 'has-events' : ''} ${inRange ? 'in-range' : ''}"
                    data-mini-day="${d.toISOString()}" tabindex="${isSelected ? 0 : -1}" role="button"
                    aria-label="${label}"${isToday ? ' aria-current="date"' : ''}${inRange ? ' aria-pressed="true"' : ''}>${col + 1}</div>`;
    }
  }

  html += `</div>`;
  // Any re-render (picking a day, background refresh) replaces the cells; put
  // keyboard focus back on the same day instead of dropping it to <body>.
  const focusedDay = document.activeElement?.getAttribute?.('data-mini-day');
  container.innerHTML = html;
  const dayCells = [...container.querySelectorAll('[data-mini-day]')];
  const cellFor = date => dayCells.find(el => sameDay(new Date(el.dataset.miniDay), date));
  const restore = pendingMiniFocus ? cellFor(pendingMiniFocus) : dayCells.find(el => el.dataset.miniDay === focusedDay);
  if (restore) {
    pendingMiniFocus = null;
    restore.focus();
  }

  // Within the month only focus moves; leaving it shows the target month, and the main view
  // moves there as with ‹ ›.
  const moveFocus = (from, to) => {
    const target = cellFor(to);
    if (target) {
      from.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    } else {
      pendingMiniFocus = to;
      onDayClick(to);
    }
  };

  dayCells.forEach(el => {
    el.addEventListener('click', () => onDayClick(new Date(el.dataset.miniDay)));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onDayClick(new Date(el.dataset.miniDay));
        return;
      }
      const target = miniKeyTarget(e.key, new Date(el.dataset.miniDay));
      if (target) {
        e.preventDefault();
        moveFocus(el, target);
      }
    });
  });
  container.querySelector('[data-mini-prev]')?.addEventListener('click', () => {
    onDayClick(navigate('month', currentDate, -1));
  });
  container.querySelector('[data-mini-next]')?.addEventListener('click', () => {
    onDayClick(navigate('month', currentDate, +1));
  });
}

// ── Month View ────────────────────────────────────────────────────────────────

function renderMonth(container, events, currentDate, cb) {
  const today  = new Date(); today.setHours(0,0,0,0);
  const month  = currentDate.getMonth();
  const year   = currentDate.getFullYear();

  const first    = new Date(year, month, 1);
  const gridStart = startOfWeek(first);
  const startDay = Math.round((first - gridStart) / 86400000);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const div = document.createElement('div');
  div.className = 'month-view';
  div.setAttribute('role', 'grid');
  div.setAttribute('aria-label', 'Monatsansicht');

  // Day-of-week header, from the user's week start (#625)
  div.innerHTML = `<div class="month-dow-header" role="row">${weekDays(gridStart).map(d =>
    `<div class="month-dow" role="columnheader" aria-label="${weekdayName(d, 'long')}">${weekdayName(d)}</div>`).join('')}</div>`;

  const grid = document.createElement('div');
  grid.className = 'month-grid';
  grid.setAttribute('role', 'rowgroup');

  let currentWeekRow = null;

  for (let i = 0; i < 42; i++) {
    if (i % 7 === 0) {
      currentWeekRow = document.createElement('div');
      currentWeekRow.className = 'month-row';
      currentWeekRow.setAttribute('role', 'row');
      currentWeekRow.style.display = 'contents';
      grid.appendChild(currentWeekRow);
    }

    const col = i - startDay;
    const date = new Date(year, month, col + 1);
    const isCurrentMonth = col >= 0 && col < daysInMonth;
    const isToday = sameDay(date, today);
    const isSelected = sameDay(date, currentDate);

    const dayEvents = eventsForDay(events, date);
    const MAX_VISIBLE = 12;
    const overflow = dayEvents.length - MAX_VISIBLE;

    const cell = document.createElement('div');
    cell.className = `month-day${isCurrentMonth ? '' : ' other-month'}${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`;
    cell.dataset.date = date.toISOString();
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', dayCellLabel(date, dayEvents.length));
    if (isToday) cell.setAttribute('aria-current', 'date');
    if (isSelected) cell.setAttribute('aria-selected', 'true');

    let chipsHtml = dayEvents.slice(0, MAX_VISIBLE).map(ev => chipHtml(ev)).join('');
    if (overflow > 0) {
      const overflowText = overflow === 1 ? '+1 weiterer' : `+${overflow} weitere`;
      chipsHtml += `<div class="month-more" data-event-overflow="${date.toISOString()}" role="button" tabindex="0" aria-label="${overflowText}">${overflowText}</div>`;
    }

    // #517: the row's ISO week number, in its first day (the week start).
    const week = i % 7 === 0 && store.get('showWeekNumbers') ? rowWeekNumber(date) : null;
    const weekHtml = week === null ? '' : `<span class="month-week-num" aria-label="Kalenderwoche ${week}">KW ${week}</span>`;
    cell.innerHTML = `<div class="month-day-head"><div class="month-day-num">${date.getDate()}</div>${weekHtml}</div>${chipsHtml}`;


    if (!isCurrentMonth) {
      cell.setAttribute('aria-disabled', 'true');
    }

    // Click on day → create event
    if (isCurrentMonth) {
      cell.addEventListener('click', e => {
        if (e.target.closest('.event-chip') || e.target.closest('.month-more')) return;
        cb.onDayClick(date);
      });
    }

    // Click on chip → show event
    cell.addEventListener('click', e => {
      const chip = e.target.closest('[data-event-uid]');
      if (chip) { e.stopPropagation(); cb.onEventClick(chip.dataset.eventUid, e); }
    });

    currentWeekRow.appendChild(cell);
  }

  div.appendChild(grid);
  container.appendChild(div);
  enableDrag(div, events, cb);

  // Re-attach chip click / keydown on view element
  div.addEventListener('click', e => {
    const chip = e.target.closest('[data-event-uid]');
    if (chip) cb.onEventClick(chip.dataset.eventUid, e);
  });
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const chip = e.target.closest('[data-event-uid]');
      if (chip) {
        e.preventDefault();
        cb.onEventClick(chip.dataset.eventUid, e);
      }
    }
  });
}

// Issue #577: a task shown by its due date.
function taskLabel(ev) {
  return ev.kind === 'task' ? 'Aufgabe: ' : '';
}

// Issue #174: an event whose optimistic save is still running.
function pendingLabel(ev) {
  return ev.pending ? ' (wird gespeichert)' : '';
}

export function chipHtml(ev) {
  const cal   = calendarById(ev.calendarId);
  const color = sanitizeColor(cal?.color || '#6366f1');
  const timeStr = ev.allDay ? '' : `<span class="event-chip-time">${fmtTime(ev.start)}</span>`;
  const labelText = taskLabel(ev) + (ev.allDay ? ev.title : `${fmtTime(ev.start)} ${ev.title}`) + pendingLabel(ev);
  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';
  return `<div class="event-chip${ev.kind === 'task' ? ' calendar-task' : ''}${ev.pending ? ' event-pending' : ''}"
              tabindex="0"
              role="button"
              aria-label="${escHtml(labelText)}"
              style="--event-color:${escHtml(color)};"
              data-event-uid="${escHtml(ev.uid)}">
            ${timeStr}
            <span class="event-chip-title">${escHtml(ev.title)}</span>
            ${recurIcon}
          </div>`;
}

// ── Second time zone (#509) ───────────────────────────────────────────────────

function zoneBadge(cls, timeZone, instant) {
  const abbr = zoneAbbreviation(timeZone, instant);
  return `<span class="tz-badge ${cls}" title="${escHtml(timeZone)}">${abbr ? `<span class="tz-abbr">${escHtml(abbr)}</span> ` : ''}<span class="tz-offset">${zoneOffsetLabel(timeZone, instant)}</span></span>`;
}

// Above the hour axis: the grid's own zone and the second one, each with abbreviation and
// offset as they are at noon of that day.
function dualGutterHtml(cls, day, secTz) {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  return `<div class="${cls} dual-tz-gutter" aria-hidden="true">
         ${zoneBadge('pri', localTimeZone(), noon)}
         ${zoneBadge('sec', secTz, noon)}
       </div>`;
}

// One label of the hour axis. The second zone's time is taken at the very instant the grid line
// stands for on that day, so a DST change in either zone shows exactly where it happens.
function hourLabelHtml(cls, h, day, secTz) {
  if (!secTz || h === 0 || h === TOTAL_HOURS) {
    return `<div class="${cls}" style="top:${h*HOUR_H}px">${h === 0 ? '' : fmtHour(h)}</div>`;
  }
  const instant = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h);
  return `<div class="${cls} dual-tz" data-hour="${h}" style="top:${h*HOUR_H}px">
        <span class="pri-time">${String(h).padStart(2, '0')}:00</span>
        <span class="sec-time">${timeInZone(secTz, instant)}</span>
      </div>`;
}

// ── Week View ─────────────────────────────────────────────────────────────────

function renderWeek(container, events, currentDate, cb, view = 'week') {
  const isWorkWeek = (view === 'workweek');
  const today = new Date(); today.setHours(0,0,0,0);
  const ws    = view === '3day' ? dayStart(currentDate) : isWorkWeek ? startOfWeek(currentDate, 1) : startOfWeek(currentDate);
  const numDays = view === '3day' ? 3 : isWorkWeek ? 5 : 7;
  const days  = Array.from({length: numDays}, (_, i) => {
    const d = new Date(ws); d.setDate(ws.getDate() + i); return d;
  });

  // The week view's axis is one column for all days; it shows the zones as on the current day.
  const secondaryTz = store.get('secondaryTimezone');
  const showSecondary = Boolean(secondaryTz);
  const gutterW = showSecondary ? '110px' : '60px';

  // The hour axis is a visual aid only: every event block names its own times.
  // Hiding it keeps the grid to one column per day under its column header.
  const gutterHtml = showSecondary
    ? dualGutterHtml('week-time-gutter', currentDate, secondaryTz)
    : `<div class="week-time-gutter" aria-hidden="true"></div>`;

  const wrap = document.createElement('div');
  wrap.className = 'week-view';
  wrap.setAttribute('role', 'grid');
  wrap.setAttribute('aria-label', view === '3day' ? 'Dreitagesansicht' : isWorkWeek ? 'Arbeitswochenansicht' : 'Wochenansicht');

  // Header row
  const header = document.createElement('div');
  header.className = 'week-header-row';
  header.setAttribute('role', 'row');
  header.style.gridTemplateColumns = `${gutterW} repeat(${numDays}, 1fr)`;
  header.innerHTML = gutterHtml;
  // #517: the week's ISO number above the hour axis.
  if (store.get('showWeekNumbers')) {
    const week = rowWeekNumber(ws);
    header.firstElementChild.insertAdjacentHTML('afterbegin', `<div class="week-num">KW ${week}</div>`);
    wrap.setAttribute('aria-label', `${wrap.getAttribute('aria-label')}, Kalenderwoche ${week}`);
  }
  days.forEach(d => {
    const isToday = sameDay(d, today);
    const allDayEvs = eventsForDay(events, d).filter(e => Boolean(e.allDay));
    const allDayHtml = allDayEvs.length > 0
      ? `<div class="all-day-events">${allDayEvs.map(ev => chipHtml(ev)).join('')}</div>`
      : '';
    header.innerHTML += `
      <div class="week-day-header${isToday ? ' today' : ''}" data-date="${d.toISOString()}"
           role="columnheader" aria-label="${dayHeaderLabel(d, allDayEvs.length)}${weatherLabelSuffix(d)}"${isToday ? ' aria-current="date"' : ''}>
        <div class="week-day-label">${weekdayName(d)}</div>
        <div class="week-day-num">${d.getDate()}</div>
        ${weatherBadgeHtml(d)}
        ${allDayHtml}
      </div>`;
  });
  wrap.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'week-grid-body';
  body.setAttribute('role', 'row');
  body.style.gridTemplateColumns = `${gutterW} repeat(${numDays}, 1fr)`;

  // Time column
  const timeCol = document.createElement('div');
  timeCol.className = `week-time-col${showSecondary ? ' dual-tz' : ''}`;
  timeCol.setAttribute('aria-hidden', 'true');
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    timeCol.innerHTML += hourLabelHtml('week-hour-label', h, currentDate, secondaryTz);
  }
  body.appendChild(timeCol);

  // Day columns
  const cols = document.createElement('div');
  cols.className = 'week-columns';
  cols.setAttribute('role', 'none');
  cols.style.height = `${TOTAL_HOURS * HOUR_H}px`;
  cols.style.position = 'relative';
  cols.style.gridColumn = `2 / span ${numDays}`;

  days.forEach(d => {
    const col = createTimeCol(events, d, cb);
    cols.appendChild(col);
  });

  // Current time line
  appendCurrentTimeLine(cols, days);

  body.appendChild(cols);
  wrap.appendChild(body);

  wrap.addEventListener('click', e => {
    const chip = e.target.closest('[data-event-uid]');
    if (chip && !e.target.closest('.time-slot-click-area')) {
      e.stopPropagation();
      cb.onEventClick(chip.dataset.eventUid, e);
    }
  });
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const chip = e.target.closest('[data-event-uid]');
      if (chip) {
        e.preventDefault();
        cb.onEventClick(chip.dataset.eventUid, e);
      }
    }
  });

  container.appendChild(wrap);
  enableDrag(wrap, events, cb);

  // Scroll to 8am
  setTimeout(() => { body.scrollTop = 8 * HOUR_H - 30; }, 10);
}

// ── Day View ──────────────────────────────────────────────────────────────────

function renderDay(container, events, currentDate, cb) {
  const wrap = document.createElement('div');
  wrap.className = 'day-view';
  wrap.setAttribute('role', 'grid');
  wrap.setAttribute('aria-label', 'Tagesansicht');
  const today = new Date(); today.setHours(0,0,0,0);
  const isToday = sameDay(currentDate, today);

  const secondaryTz = store.get('secondaryTimezone');
  const showSecondary = Boolean(secondaryTz);
  const gutterW = showSecondary ? '110px' : '60px';

  const gutterHtml = showSecondary
    ? dualGutterHtml('day-time-gutter', currentDate, secondaryTz)
    : `<div class="day-time-gutter" aria-hidden="true"></div>`;

  const allDayEvs = eventsForDay(events, currentDate).filter(e => Boolean(e.allDay));
  const allDayHtml = allDayEvs.length > 0
    ? `<div class="all-day-events">${allDayEvs.map(ev => chipHtml(ev)).join('')}</div>`
    : '';

  const header = document.createElement('div');
  header.className = 'day-header-row';
  header.setAttribute('role', 'row');
  header.style.gridTemplateColumns = `${gutterW} 1fr`;
  header.innerHTML = `
    ${gutterHtml}
    <div class="week-day-header${isToday ? ' today' : ''}" data-date="${currentDate.toISOString()}"
         role="columnheader" aria-label="${dayHeaderLabel(currentDate, allDayEvs.length)}${weatherLabelSuffix(currentDate)}"${isToday ? ' aria-current="date"' : ''}>
      <div class="week-day-label">${weekdayName(currentDate)}</div>
      <div class="week-day-num">${currentDate.getDate()}</div>
      ${weatherBadgeHtml(currentDate)}
      ${allDayHtml}
    </div>`;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'day-grid-body';
  body.setAttribute('role', 'row');
  body.style.gridTemplateColumns = `${gutterW} 1fr`;

  const timeCol = document.createElement('div');
  timeCol.className = `day-time-col${showSecondary ? ' dual-tz' : ''}`;
  timeCol.setAttribute('aria-hidden', 'true');
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    timeCol.innerHTML += hourLabelHtml('day-hour-label', h, currentDate, secondaryTz);
  }
  body.appendChild(timeCol);

  const cols = document.createElement('div');
  cols.className = 'day-columns';
  cols.setAttribute('role', 'none');
  cols.style.height = `${TOTAL_HOURS * HOUR_H}px`;
  cols.style.position = 'relative';

  const col = createTimeCol(events, currentDate, cb);
  col.style.flex = '1';
  cols.appendChild(col);

  if (isToday) appendCurrentTimeLine(cols, [currentDate]);

  body.appendChild(cols);
  wrap.appendChild(body);

  wrap.addEventListener('click', e => {
    const chip = e.target.closest('[data-event-uid]');
    if (chip && !e.target.closest('.time-slot-click-area')) {
      e.stopPropagation();
      cb.onEventClick(chip.dataset.eventUid, e);
    }
  });
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const chip = e.target.closest('[data-event-uid]');
      if (chip) {
        e.preventDefault();
        cb.onEventClick(chip.dataset.eventUid, e);
      }
    }
  });

  container.appendChild(wrap);
  enableDrag(wrap, events, cb);
  setTimeout(() => { body.scrollTop = 8 * HOUR_H - 30; }, 10);
}

// #574/#575: events move and resize by drag and drop when the app passes the drop handler;
// #576: dragging on empty space opens the new-event dialog for the drawn range.
function enableDrag(wrap, events, cb) {
  if (!cb.onEventDrop) return;
  enableEventDrag(wrap, {
    events, hourHeight: HOUR_H,
    canDrag: cb.canDrag, onDrop: cb.onEventDrop, readOnlyNotice: cb.readOnlyNotice,
    onCreateRange: cb.onCreateRange, announce: cb.announce
  });
}

function createTimeCol(allEvents, date, cb) {
  const col = document.createElement('div');
  const wh = store.get('workingHours') || { startHour: 9, endHour: 17, workDays: '1,2,3,4,5' };
  const workDaysList = (wh.workDays || '1,2,3,4,5').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  // #514: a shown public holiday is a non-working day (#19).
  const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const isHoliday = allEvents.some(ev => ev.isHoliday && ev.holidayDate === dayKey);
  const isWorkDay = workDaysList.includes(date.getDay()) && !isHoliday;

  col.className = `week-day-col${!isWorkDay ? ' non-working-day' : ''}${isHoliday ? ' holiday-day' : ''}`;
  const midnight = new Date(date); midnight.setHours(0, 0, 0, 0);
  col.dataset.date = midnight.toISOString();
  col.style.height = `${TOTAL_HOURS * HOUR_H}px`;
  col.style.position = 'relative';

  // Hour lines and click areas
  for (let h = 0; h < TOTAL_HOURS; h++) {
    const isWorkingHour = isWorkDay && (h >= wh.startHour && h < wh.endHour);

    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_H}px`;
    col.appendChild(line);

    const halfLine = document.createElement('div');
    halfLine.className = 'half-hour-line';
    halfLine.style.top = `${h * HOUR_H + 30}px`;
    col.appendChild(halfLine);

    // Click area for creating events: a click starts the new event on its 15-minute slot (#576).
    const slot = document.createElement('div');
    slot.className = `time-slot-click-area${!isWorkingHour ? ' non-working-hour' : ''}`;
    slot.style.top  = `${h * HOUR_H}px`;
    slot.style.height = `${HOUR_H}px`;
    slot.addEventListener('click', e => {
      const quarter = Math.min(3, Math.max(0, Math.floor(e.offsetY / HOUR_H * 4)));
      const d = new Date(date);
      d.setHours(h, quarter * 15, 0, 0);
      cb.onDayClick(d);
    });
    col.appendChild(slot);
  }

  // Event blocks
  const dayEvs = eventsForDay(allEvents, date).filter(e => !e.allDay);
  const laid   = layoutEvents(dayEvs);

  // All-day events sit in the column header, so the cell counts only its own.
  col.setAttribute('role', 'gridcell');
  col.setAttribute('aria-label', dayCellLabel(date, dayEvs.length));
  if (sameDay(date, new Date())) col.setAttribute('aria-current', 'date');

  for (const { ev, col: evCol, totalCols } of laid) {
    const block = createEventBlock(ev, evCol, totalCols, cb);
    col.appendChild(block);
  }

  return col;
}

function createEventBlock(ev, evCol, totalCols, cb) {
  const cal   = calendarById(ev.calendarId);
  const color = sanitizeColor(cal?.color || '#6366f1');

  const start = new Date(ev.start);
  const end   = new Date(ev.end);
  const topPx = (start.getHours() + start.getMinutes() / 60) * HOUR_H;
  const hPx   = Math.max(20, ((end - start) / 3600000) * HOUR_H);

  const w = 100 / totalCols;
  const l = evCol * w;

  const isShort = hPx <= 35 || ((end - start) <= 1800000);

  const block = document.createElement('div');
  block.className = `event-block${isShort ? ' short-event' : ''}${ev.kind === 'task' ? ' calendar-task' : ''}${ev.pending ? ' event-pending' : ''}`;
  block.style.cssText = `
    top:${topPx}px; height:${hPx}px;
    left:${l + 1}%; width:${w - 2}%;
    --event-color:${escHtml(color)};
  `;
  block.dataset.eventUid = ev.uid;
  block.setAttribute('tabindex', '0');
  block.setAttribute('role', 'button');
  const timeText = fmtTime(ev.start) + (ev.end && !isShort ? ' – ' + fmtTime(ev.end) : '');
  const labelText = timeText ? `${timeText} ${ev.title || ''}` : (ev.title || '');
  block.setAttribute('aria-label', taskLabel(ev) + labelText.trim() + pendingLabel(ev));

  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';

  block.innerHTML = `
    <div class="event-block-time">${fmtTime(ev.start)}${ev.end && !isShort ? ' – ' + fmtTime(ev.end) : ''} ${recurIcon}</div>
    <div class="event-block-title">${escHtml(ev.title)}</div>
    ${ev.location && !isShort ? `<div class="event-block-loc">${escHtml(ev.location)}</div>` : ''}
  `;

  block.addEventListener('click', e => { e.stopPropagation(); cb.onEventClick(ev.uid, e); });
  block.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      cb.onEventClick(ev.uid, e);
    }
  });
  return block;
}

function appendCurrentTimeLine(container, days) {
  clearCurrentTimeLineTimer();

  const now   = new Date();
  const isVisible = days.some(d => sameDay(d, now));
  if (!isVisible) return;

  const dayIdx = days.findIndex(d => sameDay(d, now));
  const pct    = (dayIdx / days.length) * 100;
  const w      = 100 / days.length;
  const top    = (now.getHours() + now.getMinutes() / 60) * HOUR_H;

  const line = document.createElement('div');
  line.className = 'current-time-line';
  line.style.cssText = `top:${top}px; left:${pct}%; width:${w}%;`;
  line.innerHTML = '<div class="current-time-dot"></div>';
  container.appendChild(line);

  // Update every minute with current date/time recalculation
  currentTimeLineTimer = setInterval(() => {
    const curr = new Date();
    const t = (curr.getHours() + curr.getMinutes() / 60) * HOUR_H;
    line.style.top = `${t}px`;
  }, 60_000);
}

// ── Agenda View ───────────────────────────────────────────────────────────────

function renderAgenda(container, events, currentDate, cb) {
  const today = new Date(); today.setHours(0,0,0,0);
  const div   = document.createElement('div');
  div.className = 'agenda-view';

  // Group by local calendar day: an all-day event's date is that day, a timed event's is the day
  // its start falls on here (#625: one group per day, also east of UTC).
  const byDay = new Map();
  for (const ev of events) {
    if (!ev.start) continue;
    const key = ev.allDay ? String(ev.start).slice(0, 10) : localDateString(new Date(ev.start));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  if (byDay.size === 0) {
    div.innerHTML = `<div class="agenda-empty">Keine Termine im gewählten Zeitraum.</div>`;
    container.appendChild(div);
    return;
  }

  // Sort days
  const sortedDays = [...byDay.keys()].sort();

  for (const dayKey of sortedDays) {
    const d = allDayDate(dayKey);
    const isT  = sameDay(d, today);
    const dayEvs = sortEvents(byDay.get(dayKey));

    const row = document.createElement('div');
    row.className = `agenda-day${isT ? ' today' : ''}`;

    row.innerHTML = `
      <div class="agenda-day-header">
        <span class="agenda-day-date">${formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <span class="agenda-day-name">${weekdayName(d)}</span>
      </div>
      <div class="agenda-events">
        ${dayEvs.map(ev => agendaEventHtml(ev)).join('')}
      </div>`;

    div.appendChild(row);
  }

  container.appendChild(div);
  div.addEventListener('click', e => {
    const item = e.target.closest('[data-event-uid]');
    if (item) cb.onEventClick(item.dataset.eventUid, e);
  });
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const item = e.target.closest('[data-event-uid]');
      if (item) {
        e.preventDefault();
        cb.onEventClick(item.dataset.eventUid, e);
      }
    }
  });
}

export function agendaEventHtml(ev) {
  const cal   = calendarById(ev.calendarId);
  const color = sanitizeColor(cal?.color || '#6366f1');
  const timeStr = ev.allDay ? 'Ganztägig'
    : `${fmtTime(ev.start)}${ev.end ? ' – ' + fmtTime(ev.end) : ''}`;

  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';

  const labelText = `${timeStr} ${ev.title}`;

  return `
    <div class="agenda-event" tabindex="0" role="button" aria-label="${escHtml(labelText)}" data-event-uid="${escHtml(ev.uid)}" style="cursor:pointer">
      <div class="agenda-event-color" style="background:${escHtml(color)}"></div>
      <div class="agenda-event-body">
        <div class="agenda-event-title">${escHtml(ev.title)} ${recurIcon}</div>
        <div class="agenda-event-meta">
          <span class="agenda-event-time">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            ${timeStr}
          </span>
          ${ev.location ? `<span class="agenda-event-loc">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
              <circle cx="12" cy="9" r="2.5"/>
            </svg>
            ${escHtml(ev.location)}
          </span>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Event Layout (overlap) ────────────────────────────────────────────────────

export function layoutEvents(events) {
  const sorted = sortEvents(events);
  if (!sorted || sorted.length === 0) return [];

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -1;

  for (const ev of sorted) {
    const start = new Date(ev.start).getTime();
    const rawEnd = new Date(ev.end || ev.start).getTime();
    const end = Math.max(start + 1, rawEnd);

    if (currentCluster.length > 0 && start < clusterMaxEnd) {
      currentCluster.push(ev);
      if (end > clusterMaxEnd) {
        clusterMaxEnd = end;
      }
    } else {
      if (currentCluster.length > 0) {
        clusters.push(currentCluster);
      }
      currentCluster = [ev];
      clusterMaxEnd = end;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const result = [];
  for (const cluster of clusters) {
    const columns = [];
    const clusterResult = [];

    for (const ev of cluster) {
      const start = new Date(ev.start).getTime();
      const rawEnd = new Date(ev.end || ev.start).getTime();
      const end = Math.max(start + 1, rawEnd);

      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= start) {
          columns[c] = end;
          clusterResult.push({ ev, col: c, totalCols: 1 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push(end);
        clusterResult.push({ ev, col: columns.length - 1, totalCols: 1 });
      }
    }

    const clusterTotalCols = columns.length;
    for (const r of clusterResult) {
      r.totalCols = clusterTotalCols;
      result.push(r);
    }
  }

  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function sortEvents(events) {
  if (!Array.isArray(events)) return [];
  return [...events].sort((a, b) => {
    const aAllDay = !!a.allDay;
    const bAllDay = !!b.allDay;
    if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;

    const aStart = a.start ? new Date(a.start).getTime() : 0;
    const bStart = b.start ? new Date(b.start).getTime() : 0;
    if (aStart !== bStart) return aStart - bStart;

    const aEnd = a.end ? new Date(a.end).getTime() : aStart;
    const bEnd = b.end ? new Date(b.end).getTime() : bStart;
    if (aEnd !== bEnd) return aEnd - bEnd;

    const aTitle = String(a.title || '');
    const bTitle = String(b.title || '');
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);

    return String(a.uid || '').localeCompare(String(b.uid || ''));
  });
}

function eventsForDay(events, date) {
  const filtered = events.filter(ev => {
    if (!ev.start) return false;
    if (ev.allDay) {
      // All-day values carry their calendar date in the first ten characters (never a UTC instant).
      const startStr = String(ev.start).slice(0, 10);
      const endStr = ev.end ? String(ev.end).slice(0, 10) : startStr;
      const dStr = localDateString(date);
      if (endStr > startStr) {
        return dStr >= startStr && dStr < endStr;
      }
      return dStr === startStr;
    }
    const s = new Date(ev.start);
    const e = ev.end ? new Date(ev.end) : s;
    const d = new Date(date); d.setHours(0,0,0,0);
    const dEnd = new Date(date); dEnd.setHours(23,59,59,999);
    return s <= dEnd && e >= d;
  });
  return sortEvents(filtered);
}

// Accessible names for the grid views (#183): "Donnerstag, 13. August 2026"
// and, for a cell, the number of events it holds.
function longDateLabel(date) {
  return formatDate(date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function dayCellLabel(date, eventCount) {
  if (eventCount === 0) return longDateLabel(date);
  return `${longDateLabel(date)}, ${eventCount === 1 ? '1 Termin' : `${eventCount} Termine`}`;
}

// Week/day column header, which also holds the day's all-day events.
function dayHeaderLabel(date, allDayCount) {
  if (allDayCount === 0) return longDateLabel(date);
  return `${longDateLabel(date)}, ${allDayCount === 1 ? '1 ganztägiger Termin' : `${allDayCount} ganztägige Termine`}`;
}

// #513: the forecast badge under a day's number in the week and day headers. Days outside the
// forecast, or no forecast at all (off or the provider down), show nothing.
const WEATHER_SYMBOLS = {
  'clear-day':         ['\u2600\uFE0E', 'Sonnig'],
  'partly-cloudy-day': ['\u26C5\uFE0E', 'Teils bewölkt'],
  'cloudy':            ['\u2601\uFE0E', 'Bewölkt'],
  'fog':               ['\u2261', 'Nebel'],
  'wind':              ['\u224B', 'Windig'],
  'rain':              ['\u2602\uFE0E', 'Regen'],
  'sleet':             ['\u2602\uFE0E', 'Schneeregen'],
  'snow':              ['\u2744\uFE0E', 'Schnee'],
  'hail':              ['\u2744\uFE0E', 'Hagel'],
  'thunderstorm':      ['\u03DF', 'Gewitter'],
};
const MM = { format: n => formatNumber(n, { maximumFractionDigits: 1 }) };

function forecastFor(date) {
  const weather = store.get('weather');
  if (!weather) return null;
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return weather.get(key) || null;
}

// The symbol comes from the provider, so only the table's own keys count ('constructor' is no symbol).
const weatherSymbol = icon => (Object.hasOwn(WEATHER_SYMBOLS, icon) ? WEATHER_SYMBOLS[icon] : ['', 'Vorhersage']);

function weatherText(day) {
  const [, name] = weatherSymbol(day.icon);
  const rain = day.precipitation > 0 ? `, ${MM.format(day.precipitation)} mm Niederschlag` : '';
  return `${name}, ${day.tempMin} bis ${day.tempMax} °C${rain}`;
}

function weatherLabelSuffix(date) {
  const day = forecastFor(date);
  return day ? `, Wetter: ${weatherText(day)}` : '';
}

function weatherBadgeHtml(date) {
  const day = forecastFor(date);
  if (!day) return '';
  const [symbol] = weatherSymbol(day.icon);
  return `<div class="weather-badge" data-weather-date="${day.date}" title="${weatherText(day)}" aria-hidden="true">`
    + `<span class="weather-icon">${symbol}</span>`
    + `<span class="weather-temp">${day.tempMax}° / ${day.tempMin}°</span></div>`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function dayStart(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  return d;
}

// "14.–16. Mai 2037" for `days` days from `ws`; across months the months are abbreviated.
function rangeTitle(ws, days) {
  const we = new Date(ws); we.setDate(ws.getDate() + days - 1);
  const month = ws.getMonth() === we.getMonth() ? 'long' : 'short';
  return dateFormat({ day: 'numeric', month, year: 'numeric' }).formatRange(ws, we);
}

const fmtTime = iso => formatTime(iso);

export function sanitizeColor(color, fallback = '#6366f1') {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed;
  if (/^(?:rgb|hsl)a?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(?:,\s*[\d.]+\s*)?\)$/i.test(trimmed) ||
      /^(?:rgb|hsl)a?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z]{3,20}$/.test(trimmed)) return trimmed;
  return fallback;
}

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtHour(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderView,
    getToolbarTitle,
    navigate,
    getDateRange,
    renderMiniCalendar,
    sanitizeColor,
    chipHtml,
    agendaEventHtml,
    escHtml
  };
}

