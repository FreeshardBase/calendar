/**
 * calendar.js — Calendar rendering engine.
 * Renders month, week, day, and agenda views.
 * Handles drag-to-move (month view) and time-grid click-to-create.
 */

import { store, visibleCalendars, calendarById } from './store.js';

const DAYS   = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar','Februar','März','April','Mai','Juni',
                'Juli','August','September','Oktober','November','Dezember'];

const HOUR_H = 60; // px per hour in time grid
const DAY_START = 0; // render from hour 0
const TOTAL_HOURS = 24;

// ── Public API ────────────────────────────────────────────────────────────────

export function renderView(container, events, view, currentDate, callbacks) {
  container.innerHTML = '';
  switch (view) {
    case 'month':  renderMonth(container, events, currentDate, callbacks); break;
    case 'week':   renderWeek(container, events, currentDate, callbacks, 'week');  break;
    case 'workweek': renderWeek(container, events, currentDate, callbacks, 'workweek'); break;
    case 'day':    renderDay(container, events, currentDate, callbacks);   break;
    case 'agenda': renderAgenda(container, events, currentDate, callbacks);break;
  }
}

export function getToolbarTitle(view, date) {
  switch (view) {
    case 'month':  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    case 'week':   return weekTitle(date);
    case 'workweek': return workweekTitle(date);
    case 'day':    return `${DAYS[date.getDay()]}, ${date.getDate()}. ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    case 'agenda': return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }
}

export function navigate(view, date, direction) {
  const d = new Date(date);
  switch (view) {
    case 'month':  d.setMonth(d.getMonth() + direction);  break;
    case 'week':   d.setDate(d.getDate() + 7 * direction); break;
    case 'workweek': d.setDate(d.getDate() + 7 * direction); break;
    case 'day':    d.setDate(d.getDate() + direction);     break;
    case 'agenda': d.setMonth(d.getMonth() + direction);  break;
  }
  return d;
}

export function getDateRange(view, date) {
  let start, end;
  switch (view) {
    case 'month': {
      start = new Date(date.getFullYear(), date.getMonth(), 1);
      const startDay = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - startDay); // back to Monday
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(start.getDate() + 41); // 42 days total (6 full weeks)
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'week': {
      start = weekStart(date);
      end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
      break;
    }
    case 'workweek': {
      start = mondayStart(date);
      end   = new Date(start); end.setDate(start.getDate() + 4); end.setHours(23, 59, 59, 999);
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

// ── Mini Calendar ─────────────────────────────────────────────────────────────

export function renderMiniCalendar(container, currentDate, events, onDayClick) {
  const today = new Date(); today.setHours(0,0,0,0);
  const month = currentDate.getMonth();
  const year  = currentDate.getFullYear();

  // Days with events for dot indicators
  const eventDays = new Set();
  for (const ev of events) {
    if (ev.start) {
      const d = new Date(ev.start);
      if (d.getMonth() === month && d.getFullYear() === year) {
        eventDays.add(d.getDate());
      }
    }
  }

  const first = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7;

  let html = `
    <div class="mini-cal-header">
      <span class="mini-cal-title">${MONTHS[month].slice(0,3)} ${year}</span>
      <div class="mini-cal-nav">
        <button data-mini-prev>‹</button>
        <button data-mini-next>›</button>
      </div>
    </div>
    <div class="mini-cal-grid">
      ${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => `<div class="mini-cal-dow">${d}</div>`).join('')}
  `;

  let day = 1;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < 42; i++) {
    const col = i - startDay;
    if (col < 0 || col >= daysInMonth) {
      html += `<div class="mini-cal-day other-month"></div>`;
    } else {
      const d = new Date(year, month, col + 1);
      const isToday    = sameDay(d, today);
      const isSelected = sameDay(d, currentDate);
      const hasEvents  = eventDays.has(col + 1);
      html += `<div class="mini-cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${hasEvents ? 'has-events' : ''}"
                    data-mini-day="${d.toISOString()}">${col + 1}</div>`;
    }
  }

  html += `</div>`;
  container.innerHTML = html;

  container.querySelectorAll('[data-mini-day]').forEach(el => {
    el.addEventListener('click', () => onDayClick(new Date(el.dataset.miniDay)));
  });
  container.querySelector('[data-mini-prev]')?.addEventListener('click', () => {
    const d = new Date(currentDate); d.setMonth(d.getMonth() - 1);
    onDayClick(d);
  });
  container.querySelector('[data-mini-next]')?.addEventListener('click', () => {
    const d = new Date(currentDate); d.setMonth(d.getMonth() + 1);
    onDayClick(d);
  });
}

// ── Month View ────────────────────────────────────────────────────────────────

function renderMonth(container, events, currentDate, cb) {
  const today  = new Date(); today.setHours(0,0,0,0);
  const month  = currentDate.getMonth();
  const year   = currentDate.getFullYear();

  const first    = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const div = document.createElement('div');
  div.className = 'month-view';

  // Day-of-week header
  div.innerHTML = `<div class="month-dow-header">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => `<div class="month-dow">${d}</div>`).join('')}</div>`;

  const grid = document.createElement('div');
  grid.className = 'month-grid';

  for (let i = 0; i < 42; i++) {
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

    let chipsHtml = dayEvents.slice(0, MAX_VISIBLE).map(ev => chipHtml(ev)).join('');
    if (overflow > 0) {
      const overflowText = overflow === 1 ? '+1 weiterer' : `+${overflow} weitere`;
      chipsHtml += `<div class="month-more" data-event-overflow="${date.toISOString()}">${overflowText}</div>`;
    }

    cell.innerHTML = `<div class="month-day-num">${date.getDate()}</div>${chipsHtml}`;


    // Click on day → create event
    cell.addEventListener('click', e => {
      if (e.target.closest('.event-chip') || e.target.closest('.month-more')) return;
      cb.onDayClick(date);
    });

    // Click on chip → show event
    cell.querySelectorAll && cell.innerHTML && true; // placeholder
    cell.addEventListener('click', e => {
      const chip = e.target.closest('[data-event-uid]');
      if (chip) { e.stopPropagation(); cb.onEventClick(chip.dataset.eventUid, e); }
    });

    grid.appendChild(cell);
  }

  div.appendChild(grid);
  container.appendChild(div);

  // Re-attach chip click after DOM insert
  container.addEventListener('click', e => {
    const chip = e.target.closest('[data-event-uid]');
    if (chip) cb.onEventClick(chip.dataset.eventUid, e);
  }, { once: false });
}

export function chipHtml(ev) {
  const cal   = calendarById(ev.calendarId);
  const color = sanitizeColor(cal?.color || '#6366f1');
  const bg    = hexToRgba(color, 0.22);
  const textColor = ensureContrastFloor(color, 0.22);
  const timeStr = ev.allDay ? '' : `<span class="event-chip-time">${fmtTime(ev.start)}</span>`;
  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-left:4px;vertical-align:middle;display:inline-block;flex-shrink:0;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';
  return `<div class="event-chip${ev.allDay ? ' all-day' : ''}"
              style="background:${escHtml(bg)};color:${escHtml(textColor)};"
              data-event-uid="${escHtml(ev.uid)}"
              title="${escHtml(ev.title)}">
            ${timeStr}
            <span class="event-chip-title">${escHtml(ev.title)}</span>
            ${recurIcon}
          </div>`;
}

// ── Timezone Helpers ──────────────────────────────────────────────────────────

function getTimezoneOffsetMinsClient(tzName, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      timeZoneName: 'longOffset',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    });
    const parts = fmt.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
    if (tzPart === 'GMT' || tzPart === 'UTC') return 0;
    const m = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
  } catch (e) {
    return 0;
  }
}

function getTimezoneAbbrClient(tzName, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzName, timeZoneName: 'short' });
    const parts = fmt.formatToParts(date);
    return parts.find(p => p.type === 'timeZoneName')?.value || tzName;
  } catch (e) {
    return tzName;
  }
}

function getDualHourLabelClient(baseHour, date, primaryTz, secondaryTz) {
  const priOffset = getTimezoneOffsetMinsClient(primaryTz, date);
  const secOffset = getTimezoneOffsetMinsClient(secondaryTz, date);
  const diffMins = secOffset - priOffset;
  let totalSecMins = baseHour * 60 + diffMins;
  totalSecMins = ((totalSecMins % 1440) + 1440) % 1440;
  const secHour = Math.floor(totalSecMins / 60);
  const secMin = totalSecMins % 60;
  const fmt = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return {
    priStr: fmt(baseHour, 0),
    secStr: fmt(secHour, secMin)
  };
}

// ── Week View ─────────────────────────────────────────────────────────────────

function renderWeek(container, events, currentDate, cb, view = 'week') {
  const isWorkWeek = (view === 'workweek');
  const today = new Date(); today.setHours(0,0,0,0);
  const ws    = isWorkWeek ? mondayStart(currentDate) : weekStart(currentDate);
  const numDays = isWorkWeek ? 5 : 7;
  const days  = Array.from({length: numDays}, (_, i) => {
    const d = new Date(ws); d.setDate(ws.getDate() + i); return d;
  });

  const primaryTz = store.get('primaryTimezone') || 'Europe/Berlin';
  const rawSecTz  = store.get('secondaryTimezone');
  const showSecondary = (rawSecTz !== null && rawSecTz !== undefined && rawSecTz !== '') || store.get('showSecondaryTimezone') === true;
  const secondaryTz  = rawSecTz || 'America/New_York';

  const gutterW = showSecondary ? '110px' : '60px';
  const priAbbr = getTimezoneAbbrClient(primaryTz, currentDate);
  const secAbbr = getTimezoneAbbrClient(secondaryTz, currentDate);

  const gutterHtml = showSecondary
    ? `<div class="week-time-gutter dual-tz-gutter" title="${primaryTz} / ${secondaryTz}">
         <span class="tz-badge pri">${priAbbr}</span>
         <span class="tz-badge sec">${secAbbr}</span>
       </div>`
    : `<div class="week-time-gutter"></div>`;

  const wrap = document.createElement('div');
  wrap.className = 'week-view';

  // Header row
  const header = document.createElement('div');
  header.className = 'week-header-row';
  header.style.gridTemplateColumns = `${gutterW} repeat(${numDays}, 1fr)`;
  header.innerHTML = gutterHtml;
  days.forEach(d => {
    const isToday = sameDay(d, today);
    header.innerHTML += `
      <div class="week-day-header${isToday ? ' today' : ''}" data-date="${d.toISOString()}">
        <div class="week-day-label">${DAYS[d.getDay()]}</div>
        <div class="week-day-num">${d.getDate()}</div>
      </div>`;
  });
  wrap.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'week-grid-body';
  body.style.gridTemplateColumns = `${gutterW} repeat(${numDays}, 1fr)`;

  // Time column
  const timeCol = document.createElement('div');
  timeCol.className = `week-time-col${showSecondary ? ' dual-tz' : ''}`;
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    if (showSecondary && h > 0 && h < TOTAL_HOURS) {
      const { priStr, secStr } = getDualHourLabelClient(h, currentDate, primaryTz, secondaryTz);
      timeCol.innerHTML += `<div class="week-hour-label dual-tz" style="top:${h*HOUR_H}px">
        <span class="pri-time">${priStr}</span>
        <span class="sec-time">${secStr}</span>
      </div>`;
    } else {
      timeCol.innerHTML += `<div class="week-hour-label" style="top:${h*HOUR_H}px">${h === 0 ? '' : fmtHour(h)}</div>`;
    }
  }
  body.appendChild(timeCol);

  // Day columns
  const cols = document.createElement('div');
  cols.className = 'week-columns';
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
  container.appendChild(wrap);

  // Scroll to 8am
  setTimeout(() => { body.scrollTop = 8 * HOUR_H - 30; }, 10);
}

// ── Day View ──────────────────────────────────────────────────────────────────

function renderDay(container, events, currentDate, cb) {
  const today = new Date(); today.setHours(0,0,0,0);
  const isToday = sameDay(currentDate, today);

  const primaryTz = store.get('primaryTimezone') || 'Europe/Berlin';
  const rawSecTz  = store.get('secondaryTimezone');
  const showSecondary = (rawSecTz !== null && rawSecTz !== undefined && rawSecTz !== '') || store.get('showSecondaryTimezone') === true;
  const secondaryTz  = rawSecTz || 'America/New_York';

  const gutterW = showSecondary ? '110px' : '60px';
  const priAbbr = getTimezoneAbbrClient(primaryTz, currentDate);
  const secAbbr = getTimezoneAbbrClient(secondaryTz, currentDate);

  const gutterHtml = showSecondary
    ? `<div class="day-time-gutter dual-tz-gutter" title="${primaryTz} / ${secondaryTz}">
         <span class="tz-badge pri">${priAbbr}</span>
         <span class="tz-badge sec">${secAbbr}</span>
       </div>`
    : `<div class="day-time-gutter"></div>`;

  const wrap = document.createElement('div');
  wrap.className = 'day-view';

  const header = document.createElement('div');
  header.className = 'day-header-row';
  header.style.gridTemplateColumns = `${gutterW} 1fr`;
  header.innerHTML = `
    ${gutterHtml}
    <div class="week-day-header${isToday ? ' today' : ''}">
      <div class="week-day-label">${DAYS[currentDate.getDay()]}</div>
      <div class="week-day-num">${currentDate.getDate()}</div>
    </div>`;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'day-grid-body';
  body.style.gridTemplateColumns = `${gutterW} 1fr`;

  const timeCol = document.createElement('div');
  timeCol.className = `day-time-col${showSecondary ? ' dual-tz' : ''}`;
  for (let h = 0; h <= TOTAL_HOURS; h++) {
    if (showSecondary && h > 0 && h < TOTAL_HOURS) {
      const { priStr, secStr } = getDualHourLabelClient(h, currentDate, primaryTz, secondaryTz);
      timeCol.innerHTML += `<div class="day-hour-label dual-tz" style="top:${h*HOUR_H}px">
        <span class="pri-time">${priStr}</span>
        <span class="sec-time">${secStr}</span>
      </div>`;
    } else {
      timeCol.innerHTML += `<div class="day-hour-label" style="top:${h*HOUR_H}px">${h === 0 ? '' : fmtHour(h)}</div>`;
    }
  }
  body.appendChild(timeCol);

  const cols = document.createElement('div');
  cols.className = 'day-columns';
  cols.style.height = `${TOTAL_HOURS * HOUR_H}px`;
  cols.style.position = 'relative';

  const col = createTimeCol(events, currentDate, cb);
  col.style.flex = '1';
  cols.appendChild(col);

  if (isToday) appendCurrentTimeLine(cols, [currentDate]);

  body.appendChild(cols);
  wrap.appendChild(body);
  container.appendChild(wrap);
  setTimeout(() => { body.scrollTop = 8 * HOUR_H - 30; }, 10);
}

function createTimeCol(allEvents, date, cb) {
  const col = document.createElement('div');
  const wh = store.get('workingHours') || { startHour: 9, endHour: 17, workDays: '1,2,3,4,5' };
  const workDaysList = (wh.workDays || '1,2,3,4,5').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  const isWorkDay = workDaysList.includes(date.getDay());

  col.className = `week-day-col${!isWorkDay ? ' non-working-day' : ''}`;
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

    // Click area for creating events
    const slot = document.createElement('div');
    slot.className = `time-slot-click-area${!isWorkingHour ? ' non-working-hour' : ''}`;
    slot.style.top  = `${h * HOUR_H}px`;
    slot.style.height = `${HOUR_H}px`;
    slot.addEventListener('click', () => {
      const d = new Date(date);
      d.setHours(h, 0, 0, 0);
      cb.onDayClick(d);
    });
    col.appendChild(slot);
  }

  // Event blocks
  const dayEvs = eventsForDay(allEvents, date).filter(e => !e.allDay);
  const laid   = layoutEvents(dayEvs);

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

  const textColor = ensureContrastFloor(color, 0.25);

  const block = document.createElement('div');
  block.className = `event-block${isShort ? ' short-event' : ''}`;
  block.style.cssText = `
    top:${topPx}px; height:${hPx}px;
    left:${l + 1}%; width:${w - 2}%;
    background:${hexToRgba(color, 0.25)};
    color:${escHtml(textColor)};
    border-left-color:${escHtml(color)};
  `;
  block.dataset.eventUid = ev.uid;

  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-left:4px;vertical-align:middle;display:inline-block;flex-shrink:0;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';

  block.innerHTML = `
    <div class="event-block-time">${fmtTime(ev.start)}${ev.end && !isShort ? ' – ' + fmtTime(ev.end) : ''} ${recurIcon}</div>
    <div class="event-block-title">${escHtml(ev.title)}</div>
    ${ev.location && !isShort ? `<div class="event-block-loc">${escHtml(ev.location)}</div>` : ''}
  `;

  block.addEventListener('click', e => { e.stopPropagation(); cb.onEventClick(ev.uid, e); });
  return block;
}

function appendCurrentTimeLine(container, days) {
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

  // Update every minute
  setInterval(() => {
    const t = (now.getHours() + now.getMinutes() / 60) * HOUR_H;
    line.style.top = `${t}px`;
  }, 60_000);
}

// ── Agenda View ───────────────────────────────────────────────────────────────

function renderAgenda(container, events, currentDate, cb) {
  const today = new Date(); today.setHours(0,0,0,0);
  const div   = document.createElement('div');
  div.className = 'agenda-view';

  // Group by day
  const byDay = new Map();
  for (const ev of events) {
    if (!ev.start) continue;
    const key = new Date(ev.start).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  if (byDay.size === 0) {
    div.innerHTML = `<div class="agenda-empty">Keine Termine im gewählten Zeitraum.</div>`;
    container.appendChild(div);
    return;
  }

  // Sort days
  const sortedDays = [...byDay.keys()].sort((a, b) => new Date(a) - new Date(b));

  for (const dayKey of sortedDays) {
    const d    = new Date(dayKey);
    const isT  = sameDay(d, today);
    const dayEvs = sortEvents(byDay.get(dayKey));

    const row = document.createElement('div');
    row.className = `agenda-day${isT ? ' today' : ''}`;

    row.innerHTML = `
      <div class="agenda-day-header">
        <span class="agenda-day-date">${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}</span>
        <span class="agenda-day-name">${DAYS[d.getDay()]}</span>
      </div>
      <div class="agenda-events">
        ${dayEvs.map(ev => agendaEventHtml(ev)).join('')}
      </div>`;

    div.appendChild(row);
  }

  container.appendChild(div);
  container.addEventListener('click', e => {
    const item = e.target.closest('[data-event-uid]');
    if (item) cb.onEventClick(item.dataset.eventUid, e);
  });
}

export function agendaEventHtml(ev) {
  const cal   = calendarById(ev.calendarId);
  const color = sanitizeColor(cal?.color || '#6366f1');
  const timeStr = ev.allDay ? 'Ganztägig'
    : `${fmtTime(ev.start)}${ev.end ? ' – ' + fmtTime(ev.end) : ''}`;

  const recurIcon = (ev.recurrence || ev.masterUid)
    ? `<svg class="recur-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-left:4px;vertical-align:middle;display:inline-block;flex-shrink:0;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>`
    : '';

  return `
    <div class="agenda-event" data-event-uid="${escHtml(ev.uid)}" style="cursor:pointer">
      <div class="agenda-event-color" style="background:${escHtml(color)}"></div>
      <div class="agenda-event-body">
        <div class="agenda-event-title">${escHtml(ev.title)} ${recurIcon}</div>
        <div class="agenda-event-meta">
          <span class="agenda-event-time">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            ${timeStr}
          </span>
          ${ev.location ? `<span class="agenda-event-loc">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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

function layoutEvents(events) {
  const sorted = sortEvents(events);
  const result = [];
  const columns = []; // track column end times

  for (const ev of sorted) {
    const start = new Date(ev.start).getTime();
    const end   = new Date(ev.end || ev.start).getTime();

    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= start) {
        columns[c] = end;
        result.push({ ev, col: c, totalCols: 1 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push(end);
      result.push({ ev, col: columns.length - 1, totalCols: 1 });
    }
  }

  // Set totalCols = max overlapping columns
  const maxCol = Math.max(0, ...result.map(r => r.col));
  for (const r of result) r.totalCols = maxCol + 1;

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
      const startStr = typeof ev.start === 'string' ? ev.start.slice(0, 10) : new Date(ev.start).toISOString().slice(0, 10);
      const endStr = ev.end ? (typeof ev.end === 'string' ? ev.end.slice(0, 10) : new Date(ev.end).toISOString().slice(0, 10)) : startStr;
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dStr = `${y}-${m}-${d}`;
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

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function mondayStart(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

function workweekTitle(date) {
  const ws = mondayStart(date);
  const we = new Date(ws); we.setDate(ws.getDate() + 4);
  if (ws.getMonth() === we.getMonth()) {
    return `${ws.getDate()}. – ${we.getDate()}. ${MONTHS[we.getMonth()]} ${we.getFullYear()}`;
  }
  return `${ws.getDate()}. ${MONTHS[ws.getMonth()].slice(0,3)} – ${we.getDate()}. ${MONTHS[we.getMonth()].slice(0,3)} ${we.getFullYear()}`;
}

function weekStart(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

function weekTitle(date) {
  const ws = weekStart(date);
  const we = new Date(ws); we.setDate(ws.getDate() + 6);
  if (ws.getMonth() === we.getMonth()) {
    return `${ws.getDate()}. – ${we.getDate()}. ${MONTHS[we.getMonth()]} ${we.getFullYear()}`;
  }
  return `${ws.getDate()}. ${MONTHS[ws.getMonth()].slice(0,3)} – ${we.getDate()}. ${MONTHS[we.getMonth()].slice(0,3)} ${we.getFullYear()}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function parseHexColor(hex) {
  const clean = sanitizeColor(hex, '#6366f1');
  if (clean.startsWith('#')) {
    let h = clean.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
      };
    }
  }
  return { r: 99, g: 102, b: 241 };
}

function getRelativeLuminance({ r, g, b }) {
  const sR = r / 255;
  const sG = g / 255;
  const sB = b / 255;
  const R = sR <= 0.03928 ? sR / 12.92 : Math.pow((sR + 0.055) / 1.055, 2.4);
  const G = sG <= 0.03928 ? sG / 12.92 : Math.pow((sG + 0.055) / 1.055, 2.4);
  const B = sB <= 0.03928 ? sB / 12.92 : Math.pow((sB + 0.055) / 1.055, 2.4);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function getContrastRatio(lum1, lum2) {
  const l1 = Math.max(lum1, lum2);
  const l2 = Math.min(lum1, lum2);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function ensureContrastFloor(color, bgAlpha = 0.22, minRatio = 4.5) {
  const rgb = parseHexColor(color);
  const bgR = Math.round((1 - bgAlpha) * 255 + bgAlpha * rgb.r);
  const bgG = Math.round((1 - bgAlpha) * 254 + bgAlpha * rgb.g);
  const bgB = Math.round((1 - bgAlpha) * 251 + bgAlpha * rgb.b);
  const bgLum = getRelativeLuminance({ r: bgR, g: bgG, b: bgB });

  const textLum = getRelativeLuminance(rgb);
  if (getContrastRatio(bgLum, textLum) >= minRatio) {
    return sanitizeColor(color, '#6366f1');
  }

  let factor = 0.85;
  while (factor > 0.1) {
    const curR = Math.floor(rgb.r * factor);
    const curG = Math.floor(rgb.g * factor);
    const curB = Math.floor(rgb.b * factor);
    const curLum = getRelativeLuminance({ r: curR, g: curG, b: curB });
    if (getContrastRatio(bgLum, curLum) >= minRatio) {
      const toHex = (n) => n.toString(16).padStart(2, '0');
      return `#${toHex(curR)}${toHex(curG)}${toHex(curB)}`;
    }
    factor -= 0.05;
  }
  return '#1d3a45';
}

export function sanitizeColor(color, fallback = '#6366f1') {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed;
  if (/^(?:rgb|hsl)a?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(?:,\s*[\d.]+\s*)?\)$/i.test(trimmed) ||
      /^(?:rgb|hsl)a?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z]{3,20}$/.test(trimmed)) return trimmed;
  return fallback;
}

function hexToRgba(hex, alpha) {
  const cleanHex = sanitizeColor(hex, '#6366f1');
  if (cleanHex.startsWith('#') && (cleanHex.length === 7 || cleanHex.length === 4)) {
    const fullHex = cleanHex.length === 4
      ? `#${cleanHex[1]}${cleanHex[1]}${cleanHex[2]}${cleanHex[2]}${cleanHex[3]}${cleanHex[3]}`
      : cleanHex;
    const r = parseInt(fullHex.slice(1,3), 16);
    const g = parseInt(fullHex.slice(3,5), 16);
    const b = parseInt(fullHex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(99,102,241,${alpha})`;
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
    ensureContrastFloor,
    chipHtml,
    agendaEventHtml,
    escHtml
  };
}

