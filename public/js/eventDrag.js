/**
 * eventDrag.js — drag and drop of events in the day, week (#574) and month view (#575).
 *
 * One Pointer Events implementation for mouse, pen and touch. The mouse starts a drag once it has
 * moved a few pixels; a touch only after a long press on the event, so a swipe keeps scrolling.
 * Timed events move in a 15-minute grid (Alt: minute-exact); their top and bottom edges change
 * start and end. All-day events move by days in the all-day row and their edges change the length
 * in days. Dropping an all-day event in the time grid makes it a one-hour timed event; dropping a
 * timed event in the all-day row makes it all-day. In the month view an event moves by whole days
 * and keeps its time of day; the first and last chip of a multi-day event carry its start and end
 * edge, which change the first or last day (times stay). Esc or the "Abbrechen" zone at the top cancels.
 * Dragging on empty space draws a new event (#576): a timed range in the 15-minute grid of the
 * column it starts in, or in the month view an all-day range from the first to the last day.
 * Keyboard (#577): a focused event moves with the arrow keys, Shift+arrow changes the end and
 * Alt+Shift+arrow the start; Enter applies, Esc cancels, `announce(text)` reads the new times out.
 * Items of `kind: 'task'` (tasks shown by their due date) only move; they have no edges.
 *
 * The engine only computes the new times; `onDrop(ev, { start, end, allDay })` saves them and
 * `onCreateRange({ start, end, allDay })` opens the new-event dialog for a drawn range.
 */

import { formatDate, formatTime } from './locale.js';
import { t } from './i18n.js';

const SNAP_MIN = 15;
const LONG_PRESS_MS = 400;
const MOUSE_THRESHOLD_PX = 5;
const TOUCH_SLOP_PX = 10;
const DAY_MS = 24 * 3600 * 1000;

let active = null;          // the running drag, see startTracking
let deferredRender = null;  // a re-render asked for while a drag runs

// A re-render would replace the dragged element; it waits until the drag ends.
export function deferRenderWhileDragging(render) {
  if (!active?.armed) return false;
  deferredRender = render;
  return true;
}

// A long press has picked up an event or started drawing one: the finger is dragging, not swiping (#351).
export function isDragArmed() {
  return Boolean(active?.armed);
}

const handleHtml = edge => `<div class="event-resize-handle ${edge}" data-edge="${edge}" aria-hidden="true"></div>`;

const CHIP_SELECTOR = '.week-day-col .event-block[data-event-uid], .week-day-header .event-chip[data-event-uid], .month-day .event-chip[data-event-uid]';

/**
 * Wire drag and drop into a rendered day/week or month view.
 * `root` holds `.week-day-header[data-date]` cells (all-day row) and `.week-day-col[data-date]`
 * columns of `hourHeight` px per hour, or the `.month-day[data-date]` cells of the month view. `canDrag(ev)` answers true or the message why not, which
 * `readOnlyNotice(message)` shows when such an event is long-pressed or dragged.
 */
export function enableEventDrag(root, opts) {
  const { events, canDrag } = opts;
  const byUid = new Map(events.map(ev => [ev.uid, ev]));
  const draggable = el => {
    const ev = byUid.get(el.dataset.eventUid);
    return ev && !ev.pending && canDrag(ev) === true;
  };
  // A task has a due time, not a length: it only moves (#577).
  const resizable = el => draggable(el) && byUid.get(el.dataset.eventUid).kind !== 'task';
  root.querySelectorAll('.week-day-col .event-block[data-event-uid]').forEach(el => {
    if (resizable(el)) el.insertAdjacentHTML('beforeend', handleHtml('top') + handleHtml('bottom'));
  });
  root.querySelectorAll('.week-day-header .event-chip[data-event-uid]').forEach(el => {
    if (resizable(el)) el.insertAdjacentHTML('beforeend', handleHtml('start') + handleHtml('end'));
  });
  // Month view: a multi-day event's start edge sits on its first day's chip, the end edge on its last.
  root.querySelectorAll('.month-day[data-date] .event-chip[data-event-uid]').forEach(el => {
    if (!resizable(el)) return;
    const ev = byUid.get(el.dataset.eventUid);
    const { first, last } = daySpan(ev);
    if (first === last) return;
    const day = ymd(dayOf(el.closest('.month-day')));
    if (day === first) el.insertAdjacentHTML('beforeend', handleHtml('start'));
    if (day === last) el.insertAdjacentHTML('beforeend', handleHtml('end'));
  });

  root.addEventListener('keydown', e => onChipKey(e, byUid, opts), true);
  root.addEventListener('focusout', e => { if (keyMove && e.target === keyMove.el) clearKeyMove(); });
  // A move applied with Enter re-renders the view; the moved event gets the focus back.
  if (refocus && Date.now() < refocus.until && (!document.activeElement || document.activeElement === document.body)) {
    const el = [...root.querySelectorAll('[data-event-uid]')].find(x => x.dataset.eventUid === refocus.uid);
    el?.focus({ preventScroll: true });
  }

  root.addEventListener('pointerdown', e => {
    if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest(CHIP_SELECTOR);
    if (el) {
      const ev = byUid.get(el.dataset.eventUid);
      if (ev && !ev.pending) startTracking(e, el, ev, opts);
      return;
    }
    // Empty space of a time-grid column or a month day: draw a new event (#576).
    const area = e.target.closest('.week-day-col[data-date], .month-day[data-date]');
    if (area && opts.onCreateRange && !e.target.closest('[data-event-uid], .month-more')) startTracking(e, area, null, opts);
  });
}

function startTracking(e, el, ev, opts) {
  const handle = e.target.closest('.event-resize-handle');
  const grabCol = el.closest('.week-day-col');
  const grabHeader = el.closest('.week-day-header, .month-day');
  const pointerMin = grabCol ? minuteAt(grabCol, e.clientY, opts.hourHeight) : 0;
  const state = {
    el, ev, opts,
    pointerId: e.pointerId,
    touch: e.pointerType === 'touch',
    mode: !ev ? 'create' : handle ? handle.dataset.edge : 'move',
    x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    alt: e.altKey,
    armed: false,
    timer: null,
    ghost: null,
    target: null,
    // Minutes between the grabbed point and the event's start (timed events in the grid).
    grabOffsetMin: ev && grabCol ? pointerMin - minutesOfDay(new Date(ev.start)) : 0,
    // Where a new event's range starts (#576), in minutes of the grabbed column's day.
    anchorMin: pointerMin,
    // The day the chip was grabbed on (all-day row, month cell): a move shifts by the days from there.
    grabDay: grabHeader ? dayOf(grabHeader) : null,
  };
  active = state;
  if (state.touch) state.timer = setTimeout(() => arm(state), LONG_PRESS_MS);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancelPointer);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('contextmenu', onContextMenu, true);
}

function arm(state) {
  state.timer = null;
  if (state.ev) {
    const allowed = state.opts.canDrag(state.ev);
    if (allowed !== true) {
      stop();
      state.opts.readOnlyNotice?.(allowed);
      return;
    }
    state.el.classList.add('drag-source');
  }
  state.armed = true;
  document.body.classList.add('event-dragging');
  document.getElementById('drag-cancel-zone')?.classList.remove('hidden');
  if (state.touch && navigator.vibrate) navigator.vibrate(10);
  update(state);
}

function onMove(e) {
  const state = active;
  if (!state || e.pointerId !== state.pointerId) return;
  state.x = e.clientX; state.y = e.clientY; state.alt = e.altKey;
  const dist = Math.hypot(state.x - state.x0, state.y - state.y0);
  if (!state.armed) {
    if (state.touch) {
      // Moving before the long press is a scroll, not a drag.
      if (dist > TOUCH_SLOP_PX) stop();
      return;
    }
    if (dist < MOUSE_THRESHOLD_PX) return;
    arm(state);
    return;
  }
  update(state);
}

function onUp(e) {
  const state = active;
  if (!state || e.pointerId !== state.pointerId) return;
  if (!state.armed) { stop(); return; }
  state.x = e.clientX; state.y = e.clientY;
  update(state);
  const change = state.target?.cancel ? null : state.target?.change;
  stop();
  // The release ends a drag, not a click: no popover opens.
  swallowNextClick();
  if (!change) return;
  if (!state.ev) state.opts.onCreateRange(change);
  else if (!sameTimes(state.ev, change)) state.opts.onDrop(state.ev, change);
}

function onCancelPointer(e) {
  if (active && e.pointerId === active.pointerId) stop();
}

function onKey(e) {
  if (e.key !== 'Escape' || !active?.armed) return;
  e.preventDefault();
  e.stopPropagation();
  stop();
  swallowNextClick();
}

// Once the long press armed the drag, the finger moves the event and not the page.
function onTouchMove(e) {
  if (active?.armed) e.preventDefault();
}

function onContextMenu(e) {
  if (active?.touch) e.preventDefault();
}

function swallowNextClick() {
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

function stop() {
  const state = active;
  active = null;
  if (!state) return;
  clearTimeout(state.timer);
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  document.removeEventListener('pointercancel', onCancelPointer);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('touchmove', onTouchMove, { passive: false });
  document.removeEventListener('contextmenu', onContextMenu, true);
  state.el.classList.remove('drag-source');
  state.ghost?.remove();
  document.querySelectorAll('.drop-target').forEach(h => h.classList.remove('drop-target'));
  document.body.classList.remove('event-dragging');
  const zone = document.getElementById('drag-cancel-zone');
  zone?.classList.add('hidden');
  zone?.classList.remove('over');
  if (deferredRender) {
    const render = deferredRender;
    deferredRender = null;
    render();
  }
}

// ── Keyboard (#577) ───────────────────────────────────────────────────────────
// A focused event moves with the arrow keys: in the day and week view ↑/↓ by 15 minutes and ←/→ by
// a day, in the month view (and the all-day row) ←/→ by a day and ↑/↓ by a week (all-day row: no
// ↑/↓). Shift+arrow changes the end, Alt+Shift+arrow the start. The new times show as in a drag and
// are announced; Enter hands them to `onDrop`, Esc or leaving the event drops them.

let keyMove = null;  // { el, ev, opts, change, target, ghost } of the pending keyboard move
let refocus = null;  // { uid, until }: the event to focus again after the re-render of an Enter

const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

function onChipKey(e, byUid, opts) {
  const el = e.target;
  if (active || !el.matches?.(CHIP_SELECTOR)) return;
  const ev = byUid.get(el.dataset.eventUid);
  if (!ev || ev.pending) return;
  if (keyMove && keyMove.el !== el) clearKeyMove();
  if (keyMove && (e.key === 'Enter' || e.key === 'Escape')) {
    e.preventDefault();
    e.stopPropagation();
    const { change } = keyMove;
    clearKeyMove();
    if (e.key === 'Escape') {
      opts.announce?.(t('views.eventDrag.cancelled'));
    } else if (!sameTimes(ev, change)) {
      refocus = { uid: ev.uid, until: Date.now() + 15000 };
      opts.onDrop(ev, change);
    }
    return;
  }
  const arrow = ARROWS[e.key];
  if (!arrow || e.ctrlKey || e.metaKey) return;
  const mode = e.shiftKey ? (e.altKey ? 'start' : 'end') : e.altKey ? null : 'move';
  if (!mode) return;
  e.preventDefault();
  e.stopPropagation();
  const allowed = opts.canDrag(ev);
  if (allowed !== true) { opts.readOnlyNotice?.(allowed); return; }
  if (ev.kind === 'task' && mode !== 'move') return;
  const base = keyMove?.change || { start: ev.start, end: ev.end || ev.start, allDay: Boolean(ev.allDay) };
  const inGrid = Boolean(el.closest('.week-day-col'));
  const [dx, dy] = arrow;
  const step = inGrid
    ? { days: dx, minutes: dy * SNAP_MIN }
    : { days: dx + dy * 7 * (el.closest('.month-day') ? 1 : 0), minutes: 0 };
  if (!step.days && !step.minutes) return;
  const change = stepChange(base, mode, step);
  if (!change) return;
  if (!keyMove) keyMove = { el, ev, opts, ghost: null };
  keyMove.change = change;
  showKeyMove(keyMove);
  opts.announce?.(t('views.eventDrag.announce', { title: ev.title, times: describe(change) }));
}

// `base` shifted by whole days and minutes; for an edge only that end moves and stays at least one
// slot (timed) or one day (all-day) away from the other.
function stepChange(base, mode, { days, minutes }) {
  if (base.allDay) {
    const shift = v => ymd(addDays(parseYmd(v), days));
    const start = mode === 'end' ? base.start : shift(base.start);
    const end = mode === 'start' ? base.end : shift(base.end);
    return end > start ? { start, end, allDay: true } : null;
  }
  const shift = v => {
    const d = new Date(v);
    d.setDate(d.getDate() + days);
    return new Date(d.getTime() + minutes * 60000);
  };
  const start = mode === 'end' ? new Date(base.start) : shift(base.start);
  const end = mode === 'start' ? new Date(base.end) : shift(base.end);
  if (mode !== 'move' && end - start < SNAP_MIN * 60000) return null;
  return { start: start.toISOString(), end: end.toISOString(), allDay: false };
}

// Draws the pending keyboard move like a drag: a ghost in the time grid, marked days elsewhere.
function showKeyMove(state) {
  const root = state.el.closest('.week-view, .day-view, .month-view') || document;
  const { first, last } = daySpan(state.change);
  const col = state.change.allDay ? null
    : [...root.querySelectorAll('.week-day-col[data-date]')].find(c => ymd(dayOf(c)) === first);
  state.target = { change: state.change, col };
  const marked = !state.el.closest('.week-day-col')
    ? [...root.querySelectorAll('.month-day[data-date], .week-day-header[data-date]')]
      .filter(c => { const d = ymd(dayOf(c)); return d >= first && d <= last; })
    : [];
  document.querySelectorAll('.drop-target').forEach(h => { if (!marked.includes(h)) h.classList.remove('drop-target'); });
  marked.forEach(h => h.classList.add('drop-target'));
  drawGhost(state);
}

function clearKeyMove() {
  const state = keyMove;
  keyMove = null;
  if (!state) return;
  state.ghost?.remove();
  document.querySelectorAll('.drop-target').forEach(h => h.classList.remove('drop-target'));
}

function describe(change) {
  const day = d => formatDate(d, { weekday: 'short', day: '2-digit', month: '2-digit' });
  if (change.allDay) {
    const { first, last } = daySpan(change);
    return first === last
      ? t('views.eventDrag.allDay', { day: day(parseYmd(first)) })
      : t('views.eventDrag.allDayRange', { first: day(parseYmd(first)), last: day(parseYmd(last)) });
  }
  const s = new Date(change.start);
  const e = new Date(change.end);
  return ymd(s) === ymd(e) ? `${day(s)} ${hhmm(s)} – ${hhmm(e)}` : `${day(s)} ${hhmm(s)} – ${day(e)} ${hhmm(e)}`;
}

// ── Target and new times ──────────────────────────────────────────────────────

function update(state) {
  state.target = targetAt(state);
  const zone = document.getElementById('drag-cancel-zone');
  zone?.classList.toggle('over', Boolean(state.target?.cancel));
  const marked = state.target?.days || (state.target?.header ? [state.target.header] : []);
  document.querySelectorAll('.drop-target').forEach(h => {
    if (!marked.includes(h)) h.classList.remove('drop-target');
  });
  marked.forEach(h => h.classList.add('drop-target'));
  drawGhost(state);
}

function targetAt(state) {
  const zone = document.getElementById('drag-cancel-zone');
  if (zone && !zone.classList.contains('hidden') && inside(zone.getBoundingClientRect(), state.x, state.y)) {
    return { cancel: true };
  }
  const hit = document.elementFromPoint(state.x, state.y);
  if (!state.ev) return createTarget(state, hit);
  const col = hit?.closest('.week-day-col[data-date]');
  const header = hit?.closest('.week-day-header[data-date]');
  const cell = hit?.closest('.month-day[data-date]');
  if (cell) {
    const change = monthChange(state, cell);
    return change ? { change, header: cell } : null;
  }
  const change = col ? gridChange(state, col) : header ? allDayRowChange(state, header) : null;
  return change ? { change, col, header } : null;
}

// A new event's range (#576). In the time grid it stays in the grabbed column and covers every
// 15-minute slot between the press and the pointer (Alt: minute-exact), at least one slot. In the
// month view it covers the days between the grabbed cell and the cell under the pointer.
function createTarget(state, hit) {
  if (state.el.matches('.month-day')) {
    const cell = hit?.closest('.month-day[data-date]');
    if (!cell) return null;
    const a = state.grabDay;
    const b = dayOf(cell);
    const [first, last] = a <= b ? [a, b] : [b, a];
    const days = [...state.el.closest('.month-grid').querySelectorAll('.month-day[data-date]')]
      .filter(c => { const d = dayOf(c); return d >= first && d <= last; });
    return { change: { start: ymd(first), end: ymd(addDays(last, 1)), allDay: true }, days };
  }
  const col = state.el;
  const day = dayOf(col);
  const clampMin = m => Math.min(Math.max(m, 0), 24 * 60);
  const pointerMin = clampMin(minuteAt(col, state.y, state.opts.hourHeight));
  const lo = Math.min(state.anchorMin, pointerMin);
  const hi = Math.max(state.anchorMin, pointerMin);
  const startMin = Math.min(state.alt ? Math.round(lo) : Math.floor(lo / SNAP_MIN) * SNAP_MIN, 24 * 60 - SNAP_MIN);
  const endMin = Math.max(state.alt ? Math.round(hi) : Math.ceil(hi / SNAP_MIN) * SNAP_MIN, startMin + SNAP_MIN);
  const at = min => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min).toISOString();
  return { change: { start: at(startMin), end: at(endMin), allDay: false }, col };
}

// Pointer over a column of the time grid.
function gridChange(state, col) {
  const { ev, mode, alt } = state;
  const day = dayOf(col);
  const pointerMin = minuteAt(col, state.y, state.opts.hourHeight);
  const at = min => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, snap(min, alt));
  if (ev.allDay) {
    // An all-day event becomes a one-hour event where it is dropped; its edges work in the row only.
    if (mode !== 'move') return null;
    const start = at(pointerMin);
    return { start: start.toISOString(), end: new Date(start.getTime() + 3600 * 1000).toISOString(), allDay: false };
  }
  const start = new Date(ev.start);
  const end = new Date(ev.end || ev.start);
  if (mode === 'top') {
    const newStart = at(pointerMin);
    if (end - newStart < SNAP_MIN * 60000) return null;
    return { start: newStart.toISOString(), end: end.toISOString(), allDay: false };
  }
  if (mode === 'bottom') {
    const newEnd = at(pointerMin);
    if (newEnd - start < SNAP_MIN * 60000) return null;
    return { start: start.toISOString(), end: newEnd.toISOString(), allDay: false };
  }
  const newStart = at(pointerMin - state.grabOffsetMin);
  return { start: newStart.toISOString(), end: new Date(newStart.getTime() + (end - start)).toISOString(), allDay: false };
}

// Pointer over a day's cell of the all-day row.
function allDayRowChange(state, header) {
  const { ev, mode } = state;
  const day = dayOf(header);
  if (!ev.allDay) {
    // A timed event dropped in the row becomes all-day on that day.
    if (mode !== 'move') return null;
    return { start: ymd(day), end: ymd(addDays(day, 1)), allDay: true };
  }
  const start = parseYmd(ev.start);
  const end = ev.end ? parseYmd(ev.end) : addDays(start, 1);
  if (mode === 'start') {
    const newStart = day < end ? day : addDays(end, -1);
    return { start: ymd(newStart), end: ymd(end), allDay: true };
  }
  if (mode === 'end') {
    const newEnd = addDays(day, 1) > start ? addDays(day, 1) : addDays(start, 1);
    return { start: ymd(start), end: ymd(newEnd), allDay: true };
  }
  const shift = Math.round((day - state.grabDay) / DAY_MS);
  return { start: ymd(addDays(start, shift)), end: ymd(addDays(end, shift)), allDay: true };
}

// Pointer over a day of the month view: whole days, the time of day stays.
function monthChange(state, cell) {
  const { ev, mode } = state;
  if (ev.allDay) return allDayRowChange(state, cell);
  const day = dayOf(cell);
  const start = new Date(ev.start);
  const end = new Date(ev.end || ev.start);
  const onDay = time => new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    time.getHours(), time.getMinutes(), time.getSeconds());
  if (mode === 'start') {
    const newStart = onDay(start);
    return newStart < end ? { start: newStart.toISOString(), end: end.toISOString(), allDay: false } : null;
  }
  if (mode === 'end') {
    const newEnd = onDay(end);
    return newEnd > start ? { start: start.toISOString(), end: newEnd.toISOString(), allDay: false } : null;
  }
  const shift = Math.round((day - state.grabDay) / DAY_MS);
  const shifted = d => { const x = new Date(d); x.setDate(x.getDate() + shift); return x.toISOString(); };
  return { start: shifted(start), end: shifted(end), allDay: false };
}

// The first and last day (YYYY-MM-DD) an event covers in the month view.
function daySpan(ev) {
  if (ev.allDay) {
    const start = parseYmd(ev.start);
    const end = ev.end ? parseYmd(ev.end) : addDays(start, 1);
    return { first: ymd(start), last: ymd(end > start ? addDays(end, -1) : start) };
  }
  return { first: ymd(new Date(ev.start)), last: ymd(new Date(ev.end || ev.start)) };
}

function drawGhost(state) {
  const { target } = state;
  if (!target?.col || target.change.allDay) {
    state.ghost?.remove();
    state.ghost = null;
    return;
  }
  if (!state.ghost) {
    state.ghost = document.createElement('div');
    state.ghost.className = 'event-block drag-ghost';
    state.ghost.style.setProperty('--event-color', state.ev ? state.el.style.getPropertyValue('--event-color') : 'var(--accent)');
  }
  const s = new Date(target.change.start);
  const e = new Date(target.change.end);
  const hourH = state.opts.hourHeight;
  state.ghost.style.top = `${minutesOfDay(s) / 60 * hourH}px`;
  state.ghost.style.height = `${Math.max(15, (e - s) / 3600000 * hourH)}px`;
  state.ghost.style.left = '1%';
  state.ghost.style.width = '98%';
  state.ghost.textContent = `${hhmm(s)} – ${hhmm(e)}`;
  if (state.ghost.parentElement !== target.col) target.col.appendChild(state.ghost);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function snap(min, alt) {
  return alt ? Math.round(min) : Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function minuteAt(col, clientY, hourHeight) {
  return (clientY - col.getBoundingClientRect().top) / hourHeight * 60;
}

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function dayOf(el) {
  const d = new Date(el.dataset.date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function inside(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function parseYmd(value) {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const hhmm = d => formatTime(d);

function sameTimes(ev, change) {
  if (Boolean(ev.allDay) !== change.allDay) return false;
  if (change.allDay) {
    return String(ev.start).slice(0, 10) === change.start && String(ev.end || '').slice(0, 10) === change.end;
  }
  return new Date(ev.start).getTime() === new Date(change.start).getTime()
    && new Date(ev.end).getTime() === new Date(change.end).getTime();
}
