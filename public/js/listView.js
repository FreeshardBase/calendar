/**
 * listView.js — The list view (#510): a flat table of the events in a chosen range.
 *
 * Unlike the agenda (a readable, day-grouped view of the visible months), the list is a table
 * (date, time, title, calendar, location) that is sorted and filtered on the server and loaded
 * page by page, so a range of years never lands in the browser at once. Rows can be selected for
 * bulk actions: move to another calendar, delete.
 */
import { store } from './store.js';
import { EventsAPI } from './api.js';
import { calendarLabel, holdsEvents } from './calendarLabels.js';
import { confirmDialog } from './dialogFocus.js';
import { formatDate, formatTime } from './locale.js';
import { t } from './i18n.js';

const PAGE_SIZE = 50;
const COLUMNS = [
  { key: 'start', label: 'views.listView.colDate' },
  { key: null, label: 'views.listView.colTime' },
  { key: 'title', label: 'views.listView.colTitle' },
  { key: 'calendar', label: 'views.listView.colCalendar' },
  { key: 'location', label: 'views.listView.colLocation' },
];

const DATE = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' };
const dateFmt = { format: d => formatDate(d, DATE) };
const allDayFmt = { format: d => formatDate(d, { ...DATE, timeZone: 'UTC' }) };
const timeFmt = { format: d => formatTime(d) };

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultRange() {
  const from = new Date();
  const to = new Date(from);
  to.setFullYear(to.getFullYear() + 1);
  return { from: isoDay(from), to: isoDay(to) };
}

const state = {
  ...defaultRange(),
  q: '',
  sort: 'start',
  order: 'asc',
  rows: [],
  total: 0,
  selected: new Set(),
  loading: false,
  error: null,
  // The chosen range ends before it starts (shown in the current language, not stored as text).
  rangeInvalid: false,
  seq: 0,
};

let deps = null;
let filterTimer = null;

export function initListView(dependencies) {
  deps = dependencies;
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rangeBounds() {
  const [fy, fm, fd] = state.from.split('-').map(Number);
  const [ty, tm, td] = state.to.split('-').map(Number);
  return { start: new Date(fy, fm - 1, fd, 0, 0, 0, 0), end: new Date(ty, tm - 1, td, 23, 59, 59, 999) };
}

/** Loads the first page (reset) or the next page and redraws the view. */
export async function loadListPage({ reset = true } = {}) {
  const seq = ++state.seq;
  const { start, end } = rangeBounds();
  if (end < start) {
    state.rows = [];
    state.total = 0;
    state.error = null;
    state.rangeInvalid = true;
    renderIfShown();
    return;
  }
  state.rangeInvalid = false;
  if (reset) state.selected.clear();
  state.loading = true;
  state.error = null;
  renderIfShown();
  try {
    const page = await EventsAPI.page(start.toISOString(), end.toISOString(), {
      limit: PAGE_SIZE, offset: reset ? 0 : state.rows.length, sort: state.sort, order: state.order, q: state.q,
    });
    if (seq !== state.seq) return;
    state.rows = reset ? page.events : [...state.rows, ...page.events];
    state.total = page.total;
    if (page.errors.length > 0) {
      deps.showToast(t('views.listView.partialError'), 'error');
    }
  } catch (err) {
    if (seq !== state.seq) return;
    state.error = err.message;
    deps.showToast(t('views.listView.loadError', { message: err.message }), 'error');
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      renderIfShown();
    }
  }
}

function renderIfShown() {
  if (store.get('view') !== 'list') return;
  const container = document.getElementById('calendar-container');
  if (container) renderListView(container);
}

function calendarName(id) {
  const cal = (store.get('calendars') || []).find(c => c.id === id);
  return cal ? calendarLabel(cal) : '';
}

function rowDate(ev) {
  if (ev.allDay) {
    const [y, m, d] = String(ev.start).slice(0, 10).split('-').map(Number);
    return allDayFmt.format(new Date(Date.UTC(y, m - 1, d)));
  }
  return dateFmt.format(new Date(ev.start));
}

function rowTime(ev) {
  if (ev.allDay) return t('views.listView.allDay');
  return ev.end ? `${timeFmt.format(new Date(ev.start))} – ${timeFmt.format(new Date(ev.end))}` : timeFmt.format(new Date(ev.start));
}

function statusText() {
  if (state.rangeInvalid) return t('views.listView.error', { message: t('views.listView.rangeError') });
  if (state.error) return t('views.listView.error', { message: state.error });
  if (state.loading && state.rows.length === 0) return t('views.listView.loading');
  if (state.total === 0) return t('views.listView.empty');
  return t('views.listView.shown', { shown: state.rows.length, count: state.total });
}

export function renderListView(container) {
  const focusedId = document.activeElement?.id;
  const sortHeader = (col) => {
    const label = t(col.label);
    if (!col.key) return `<th scope="col">${label}</th>`;
    const active = state.sort === col.key;
    const ariaSort = active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none';
    const arrow = active ? (state.order === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th scope="col" data-sort="${col.key}" aria-sort="${ariaSort}"><button type="button" class="list-sort-btn">${label}${arrow}</button></th>`;
  };
  const writable = (store.get('calendars') || []).filter(c => !c.readOnly && holdsEvents(c));
  const allSelected = state.rows.length > 0 && state.rows.every(ev => state.selected.has(ev.uid));

  container.innerHTML = `
    <div class="list-view">
      <div class="list-controls">
        <label>${t('views.listView.from')} <input type="date" id="list-from" value="${esc(state.from)}"></label>
        <label>${t('views.listView.to')} <input type="date" id="list-to" value="${esc(state.to)}"></label>
        <input type="search" id="list-filter" class="search-input" placeholder="${t('views.listView.filterPlaceholder')}" aria-label="${t('views.listView.filterLabel')}" value="${esc(state.q)}">
      </div>
      <div class="list-bulk" id="list-bulk" ${state.selected.size === 0 ? 'hidden' : ''}>
        <span id="list-bulk-count">${t('views.listView.selectedCount', { count: state.selected.size })}</span>
        <label>${t('views.listView.moveTo')}
          <select id="list-move-target">
            ${writable.map(c => `<option value="${esc(c.id)}">${esc(calendarLabel(c))}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="toolbar-btn" id="list-move-btn">${t('views.listView.move')}</button>
        <button type="button" class="toolbar-btn" id="list-delete-btn">${t('views.listView.delete')}</button>
      </div>
      <table class="list-table" id="list-table">
        <thead><tr>
          <th scope="col"><input type="checkbox" id="list-select-all" aria-label="${t('views.listView.selectAll')}" ${allSelected ? 'checked' : ''}></th>
          ${COLUMNS.map(sortHeader).join('')}
        </tr></thead>
        <tbody>
          ${state.rows.map(ev => `
            <tr data-uid="${esc(ev.uid)}">
              <td><input type="checkbox" aria-label="${esc(t('views.listView.selectRow', { title: ev.title }))}" ${state.selected.has(ev.uid) ? 'checked' : ''}></td>
              <td class="list-date">${esc(rowDate(ev))}</td>
              <td class="list-time">${esc(rowTime(ev))}</td>
              <td><button type="button" class="list-title">${esc(ev.title)}</button></td>
              <td class="list-calendar">${esc(calendarName(ev.calendarId))}</td>
              <td class="list-location">${esc(ev.location || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="list-status" id="list-status" role="status">${esc(statusText())}</p>
      <button type="button" class="toolbar-btn" id="list-more" ${state.rows.length < state.total ? '' : 'hidden'} ${state.loading ? 'disabled' : ''}>${t('views.listView.loadMore')}</button>
    </div>`;

  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el && container.contains(el)) {
      el.focus();
      if (el.id === 'list-filter') el.setSelectionRange(el.value.length, el.value.length);
    }
  }
  attach(container);
}

function attach(container) {
  const view = container.querySelector('.list-view');
  view.querySelector('#list-from').addEventListener('change', e => { state.from = e.target.value; loadListPage(); });
  view.querySelector('#list-to').addEventListener('change', e => { state.to = e.target.value; loadListPage(); });
  view.querySelector('#list-filter').addEventListener('input', e => {
    state.q = e.target.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => loadListPage(), 250);
  });
  view.querySelectorAll('th[data-sort] button').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.closest('th').dataset.sort;
    state.order = state.sort === key && state.order === 'asc' ? 'desc' : 'asc';
    state.sort = key;
    loadListPage();
  }));
  view.querySelector('#list-more').addEventListener('click', () => loadListPage({ reset: false }));
  view.querySelector('#list-select-all').addEventListener('change', e => {
    for (const ev of state.rows) {
      if (e.target.checked) state.selected.add(ev.uid); else state.selected.delete(ev.uid);
    }
    renderIfShown();
  });
  view.querySelector('tbody').addEventListener('change', e => {
    const uid = e.target.closest('tr')?.dataset.uid;
    if (!uid) return;
    if (e.target.checked) state.selected.add(uid); else state.selected.delete(uid);
    renderIfShown();
  });
  view.querySelector('tbody').addEventListener('click', e => {
    if (!e.target.closest('.list-title')) return;
    const ev = state.rows.find(r => r.uid === e.target.closest('tr').dataset.uid);
    deps.onEventClick(ev, e);
  });
  view.querySelector('#list-move-btn').addEventListener('click', () => moveSelected(view.querySelector('#list-move-target').value));
  view.querySelector('#list-delete-btn').addEventListener('click', deleteSelected);
}

// One stored resource per series: occurrences of the same series share the href.
function selectedResources() {
  const byHref = new Map();
  for (const ev of state.rows) {
    if (state.selected.has(ev.uid) && !byHref.has(ev.href)) byHref.set(ev.href, ev);
  }
  return [...byHref.values()];
}

const masterUid = ev => ev.masterUid || ev.uid.split('::')[0];

// `messages`: the keys of the failure and the success toast.
async function runBulk(items, action, messages) {
  const failed = [];
  for (const ev of items) {
    try {
      await action(ev);
    } catch (err) {
      failed.push(t('views.listView.failedItem', { title: ev.title, message: err.message }));
    }
  }
  if (failed.length > 0) {
    deps.showToast(t(messages.failed, { failed: failed.length, count: items.length, errors: failed.join('; ') }), 'error');
  } else {
    deps.showToast(t(messages.done, { count: items.length }), 'success');
  }
  deps.onChanged();
}

async function moveSelected(targetId) {
  if (!targetId) {
    deps.showToast(t('views.listView.noTarget'), 'error');
    return;
  }
  const items = selectedResources().filter(ev => ev.calendarId !== targetId);
  // A recurring occurrence moves its whole series, as in the event dialog (#494).
  await runBulk(items, ev => EventsAPI.update(masterUid(ev), {
    ...ev,
    uid: masterUid(ev),
    calendarId: targetId,
    sourceCalendarId: ev.calendarId,
    ...(ev.recurrenceId ? { scope: 'series', recurrenceId: ev.recurrenceId } : {}),
  }), { failed: 'views.listView.moveFailed', done: 'views.listView.moved' });
}

async function deleteSelected() {
  const items = selectedResources();
  const series = items.some(ev => ev.recurrenceId || ev.recurrence || ev.masterUid);
  const n = items.length;
  const message = t(series ? 'views.listView.deleteConfirmSeries' : 'views.listView.deleteConfirm', { count: n });
  if (!(await confirmDialog(message))) return;
  await runBulk(items, ev => EventsAPI.remove(masterUid(ev), {
    calendarId: ev.calendarId, etag: ev.etag, href: ev.href,
  }), { failed: 'views.listView.deleteFailed', done: 'views.listView.deleted' });
}
