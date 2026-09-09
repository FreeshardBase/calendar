/**
 * app.js — FreeShard WebCalendar main orchestrator.
 * Entry point for all frontend logic.
 */

import { store, toggleCalendar, invalidateEventCache, cacheEvents, getCachedEvents, setCalendarSyncCache, getCalendarSyncCache } from './store.js';
import { AccountsAPI, CalendarsAPI, EventsAPI, TasksAPI } from './api.js';
import { renderView, getToolbarTitle, navigate, getDateRange, renderMiniCalendar, sanitizeColor } from './calendar.js';
import { initEventModal, openCreateModal, openEditModal, closeModal, chooseRecurrenceScope } from './eventModal.js';
import { initAccountModal, openAccountModal } from './accountModal.js';
import { initNotificationService, checkAndTriggerAlarms } from './notifications.js';
import { initTaskUI, openTaskModal, renderKanbanBoard, renderSidebarTasks } from './tasks.js';
import { initInvitations } from './invitations.js';
import { initAvailabilityManager } from './availability.js';
import { initMSGraphModal, openMSGraphModal } from './msgraph.js';
import { initDialogFocusManager, openDialog, closeDialog, confirmDialog } from './dialogFocus.js';

const { initTheme, setTheme, getStoredTheme } = (typeof window !== 'undefined' && window.ThemeManager) ? window.ThemeManager : {};

// ── Element refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

window.__appStore = store;
window.__checkAndTriggerAlarms = checkAndTriggerAlarms;

// ── Boot ──────────────────────────────────────────────────────────────────────

if (typeof initTheme === 'function') initTheme();

function parseUrlDate() {
  const params = new URLSearchParams(window.location.search);
  const dateParam = params.get('date');
  if (dateParam) {
    const parts = dateParam.split('-');
    if (parts.length === 3) {
      const parsed = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      if (!isNaN(parsed.getTime())) return parsed;
    } else {
      const parsed = new Date(dateParam);
      if (!isNaN(parsed.getTime())) {
        parsed.setHours(0, 0, 0, 0);
        return parsed;
      }
    }
  }
  return null;
}

async function boot() {
  const initialDate = parseUrlDate();
  if (initialDate) {
    store.set({ currentDate: initialDate });
  }

  window.addEventListener('popstate', () => {
    const navDate = parseUrlDate();
    if (navDate) {
      store.set({ currentDate: navDate });
      loadEvents();
    }
  });

  // Init modals first (attach event listeners)
  initEventModal();
  initAccountModal();
  initWelcomeModal();
  initIcsImport();
  initNotificationService();
  initTaskUI({ onTaskChanged: loadTasks });
  initInvitations();
  initAvailabilityManager();
  initMSGraphModal();
  initDialogFocusManager();

  if (typeof window !== 'undefined' && window.OfflineCache) {
    window.OfflineCache.registerServiceWorker();
    window.OfflineCache.initOfflineListeners();
  }


  // Attach UI event listeners
  attachListeners();

  try {
    const accounts = await AccountsAPI.list();
    store.set({ accounts });

    if (accounts.length === 0) {
      showOnboarding();
    } else {
      hideLoading();
      showApp();
      await loadCalendars();
      await loadEvents();
      await loadTasks();
      await checkOAuthTokenStatus();
      checkWelcomePopup(accounts);
    }
  } catch (err) {
    console.error('Boot error:', err);
    hideLoading();
    showApp();
    if (typeof showToast === 'function') {
      showToast('Fehler beim Laden der Kontodaten: ' + err.message, 'error');
    }
  }
}

// ── Screen transitions ────────────────────────────────────────────────────────

function hideLoading() {
  const ls = $('loading-screen');
  ls.style.opacity = '0';
  setTimeout(() => ls.classList.add('hidden'), 400);
}

function showOnboarding() {
  hideLoading();
  $('onboarding').classList.remove('hidden');
  $('app').classList.add('hidden');
}

function showApp() {
  $('onboarding').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderSidebar();
  renderCalendarView();
  announce('Kalender geladen');
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadCalendars() {
  store.set({ loadingCalendars: true });
  try {
    const res = await CalendarsAPI.list();
    store.set({ 
      calendars: res.calendars || [],
      accountErrors: res.errors || []
    });
    if (res.errors?.length) {
      res.errors.forEach(e => console.warn('[calendar load error]', e));
    }
  } catch (err) {
    showToast('Kalender konnten nicht geladen werden: ' + err.message, 'error');
  } finally {
    store.set({ loadingCalendars: false });
    renderCalendarList();
    renderSettingsAccounts();
  }
}

async function syncCalendarDelta(calendarId) {
  try {
    const cachedSync = getCalendarSyncCache(calendarId);
    const syncToken = cachedSync?.syncToken || null;
    const ctag = cachedSync?.ctag || null;
    const res = await CalendarsAPI.deltaSync(calendarId, syncToken, ctag);
    if (res && res.syncToken) {
      setCalendarSyncCache(calendarId, ctag, res.syncToken);
    }
    return res;
  } catch (err) {
    console.warn('[delta-sync] Delta sync failed for calendar:', calendarId, err.message);
    return null;
  }
}

let loadEventsSeq = 0;

async function loadEvents() {
  const seq = ++loadEventsSeq;
  const view = store.get('view');
  const date = store.get('currentDate');
  const { start, end } = getDateRange(view, date);
  const cacheKey = `${view}_${start.toISOString()}_${end.toISOString()}`;

  const cached = getCachedEvents(cacheKey);
  if (cached && Array.isArray(cached)) {
    store.set({ events: cached });
    renderCalendarView();
  } else {
    store.set({ loadingEvents: true });
    announce('Lade Termine…');
  }

  try {
    const events = await EventsAPI.list(start.toISOString(), end.toISOString());
    if (seq !== loadEventsSeq) return;
    cacheEvents(cacheKey, events);
    store.set({ events });
    renderCalendarView();
    checkAndTriggerAlarms();
  } catch (err) {
    if (seq !== loadEventsSeq) return;
    if (!cached) {
      showToast('Fehler beim Laden der Termine: ' + err.message, 'error');
      setStatus('');
    }
  } finally {
    if (seq === loadEventsSeq) {
      store.set({ loadingEvents: false });
    }
  }
}

async function loadTasks() {
  store.set({ loadingTasks: true });
  try {
    const tasks = await TasksAPI.list();
    store.set({ tasks, tasksError: null });
    renderTaskSidebar();
    if (store.get('view') === 'kanban') {
      renderCalendarView();
    }
  } catch (err) {
    console.error('Fehler beim Laden der Aufgaben:', err.message);
    store.set({ tasksError: err.message || true });
    renderTaskSidebar();
    if (store.get('view') === 'kanban') {
      renderCalendarView();
    }
    if (typeof showToast === 'function') {
      showToast('Fehler beim Laden der Aufgaben: ' + err.message, 'error');
    }
  } finally {
    store.set({ loadingTasks: false });
  }
}

function renderTaskSidebar() {
  const container = $('sidebar-task-list');
  const countBadge = $('sidebar-task-count');
  const tasks = store.get('tasks') || [];
  const tasksError = store.get('tasksError');
  renderSidebarTasks(container, countBadge, tasks, { onTaskChanged: loadTasks }, { error: tasksError });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCalendarView() {
  const container  = $('calendar-container');
  const view       = store.get('view');
  const date       = store.get('currentDate');
  const events     = getFilteredEvents();
  const searchQuery = store.get('searchQuery');

  if (view === 'kanban') {
    $('toolbar-title').textContent = 'Aufgaben (Kanban)';
    document.querySelectorAll('.view-tab').forEach(btn => {
      const isActive = btn.dataset.view === 'kanban';
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const tasks = getFilteredTasks();
    const tasksError = store.get('tasksError');
    renderKanbanBoard(container, tasks, { onTaskChanged: loadTasks }, { searchQuery, error: tasksError });
    const count = tasks.length;
    if (tasksError) {
      announce('Fehler beim Laden der Aufgaben');
    } else if (searchQuery && searchQuery.trim() && count === 0) {
      announce(`0 Ergebnisse für „${searchQuery.trim()}“`);
    } else {
      announce(`${count} Aufgabe${count !== 1 ? 'n' : ''}`);
    }
    return;
  }

  // Toolbar title
  $('toolbar-title').textContent = getToolbarTitle(view, date);

  // Sync view tabs active state
  document.querySelectorAll('.view-tab').forEach(btn => {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  renderView(container, events, view, date, {
    onDayClick:   (d) => openCreateModal(d, { onSaved: onEventSaved, onDeleted: onEventDeleted }),
    onEventClick: (uid, e) => {
      const ev = (store.get('events') || []).find(x => x.uid === uid);
      if (ev) showEventPopover(ev, e);
    }
  });

  if (searchQuery && searchQuery.trim() && events.length === 0) {
    const banner = document.createElement('div');
    banner.className = 'search-empty-banner';
    banner.innerHTML = `<span class="search-empty-icon">🔍</span> Keine Termine für „${escapeHtml(searchQuery.trim())}“ gefunden.`;
    container.insertBefore(banner, container.firstChild);
    announce(`0 Ergebnisse für „${searchQuery.trim()}“`);
  } else if (searchQuery && searchQuery.trim()) {
    const count = events.length;
    announce(`${count} Ergebnis${count !== 1 ? 'se' : ''} für „${searchQuery.trim()}“`);
  } else {
    const count = events.length;
    announce(`${count} Termin${count !== 1 ? 'e' : ''}`);
  }

  // Mini calendar
  renderMiniCalendar(
    $('mini-calendar'),
    date,
    store.get('events') || [],
    (d) => { store.set({ currentDate: d }); loadEvents(); }
  );
}

function getFilteredEvents() {
  const events   = store.get('events') || [];
  const hidden   = store.get('hiddenCalendars');
  const query    = store.get('searchQuery').toLowerCase();

  let filtered = events.filter(ev => !hidden.has(ev.calendarId));
  if (query) {
    filtered = filtered.filter(ev =>
      (ev.title || '').toLowerCase().includes(query) ||
      (ev.location || '').toLowerCase().includes(query) ||
      (ev.description || '').toLowerCase().includes(query)
    );
  }
  return filtered;
}

function getFilteredTasks() {
  const tasks = store.get('tasks') || [];
  const query = store.get('searchQuery').toLowerCase();
  if (!query) return tasks;
  return tasks.filter(t =>
    (t.title || '').toLowerCase().includes(query) ||
    (t.description || '').toLowerCase().includes(query)
  );
}

function renderSidebar() {
  renderCalendarList();
  renderTaskSidebar();
  renderSettings();
}

function renderCalendarList() {
  const list   = $('calendar-list');
  const hidden = store.get('hiddenCalendars');
  const cals   = store.get('calendars');

  if (!cals.length) {
    list.innerHTML = '<div style="font-size:0.78rem;color:var(--ink-muted);padding:4px 8px">Keine Kalender gefunden.</div>';
    return;
  }

  list.innerHTML = cals.map(c => {
    const checked = !hidden.has(c.id);
    
    const shareBtnHtml = c.isShared
      ? ''
      : `<button class="cal-action-btn" data-share-cal="${escHtml(c.id)}" title="Teilen & Link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
          </button>`;

    const editBtnHtml = c.readOnly
      ? ''
      : `<button class="cal-action-btn" data-edit-cal="${escHtml(c.id)}" title="Umbenennen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>`;

    const exportBtnHtml =
      `<button class="cal-action-btn" data-export-cal="${escHtml(c.id)}" title="Als ICS exportieren">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>`;
          
    const googleBadge = c.source === 'google'
      ? `<svg class="google-badge-icon" viewBox="0 0 24 24" width="12" height="12" style="flex-shrink:0;" title="Mit Google Kalender synchronisiert">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"/>
         </svg>`
      : '';

    return `
      <div class="calendar-item${checked ? ' checked' : ''}" data-cal-id="${escHtml(c.id)}" tabindex="0" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${escHtml(c.name)}">
        <div class="calendar-dot" style="background:${escHtml(sanitizeColor(c.color))}"></div>
        <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; justify-content: center; line-height: 1.2;">
          <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
            <span class="calendar-name" style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
            ${googleBadge}
          </div>
          ${c.isShared ? `<span style="font-size: 0.65rem; color: var(--ink-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">von ${escHtml(c.owner)}</span>` : ''}
        </div>
        <div class="cal-item-actions">
          ${shareBtnHtml}
          ${editBtnHtml}
          ${exportBtnHtml}
        </div>
        <div class="calendar-check" style="${checked ? 'background:' + escHtml(sanitizeColor(c.color)) : ''}">
          <svg class="calendar-check-icon" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" width="10" height="10">
            <path d="M2 6l3 3 5-5"/>
          </svg>
        </div>
      </div>`;
  }).join('');

  // Toggle visibility on main area click or keypress
  list.querySelectorAll('[data-cal-id]').forEach(el => {
    const handleToggle = e => {
      if (e.target.closest('[data-edit-cal]') || e.target.closest('[data-share-cal]') || e.target.closest('[data-export-cal]')) return;
      toggleCalendar(el.dataset.calId);
      renderCalendarList();
      renderCalendarView();
    };

    el.addEventListener('click', handleToggle);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('[data-edit-cal]') || e.target.closest('[data-share-cal]') || e.target.closest('[data-export-cal]')) return;
        e.preventDefault();
        handleToggle(e);
      }
    });
  });

  // Edit (rename + recolor)
  list.querySelectorAll('[data-edit-cal]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cal = store.get('calendars').find(c => c.id === btn.dataset.editCal);
      if (cal) openEditCalendarDialog(cal);
    });
  });

  // Share (internal sharing + public subscription link)
  list.querySelectorAll('[data-share-cal]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cal = store.get('calendars').find(c => c.id === btn.dataset.shareCal);
      if (cal) openShareCalendarDialog(cal);
    });
  });

  // Export as ICS download
  list.querySelectorAll('[data-export-cal]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      window.location.href = CalendarsAPI.exportUrl(btn.dataset.exportCal);
    });
  });
}

// ── ICS Import (drag & drop) ─────────────────────────────────────────────────

function initIcsImport() {
  const zone = $('ics-dropzone');
  if (!zone) return;

  const sidebar = typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector('.sidebar') : null;
  if (!sidebar) return;

  sidebar.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) {
      e.preventDefault();
      zone.classList.add('dragover');
    }
  });
  sidebar.addEventListener('dragleave', e => {
    if (!sidebar.contains(e.relatedTarget)) zone.classList.remove('dragover');
  });
  sidebar.addEventListener('drop', async e => {
    const file = [...(e.dataTransfer?.files || [])].find(f => /\.ics$/i.test(f.name) || f.type === 'text/calendar');
    if (!file) return;
    e.preventDefault();
    zone.classList.remove('dragover');
    openImportDialog(file.name, await file.text());
  });

  // Click or keydown on the zone opens a file picker as a fallback to drag & drop
  const triggerFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ics,text/calendar';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (file) openImportDialog(file.name, await file.text());
    });
    input.click();
  };

  zone.addEventListener('click', triggerFilePicker);
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerFilePicker();
    }
  });
}

function openImportDialog(fileName, icsText) {
  const eventCount = (icsText.match(/BEGIN:VEVENT/g) || []).length;
  if (eventCount === 0) {
    showToast('Die Datei enthält keine Termine.', 'error');
    return;
  }

  const writableCals = (store.get('calendars') || []).filter(c => !c.readOnly && c.source !== 'google');
  if (!writableCals.length) {
    showToast('Kein beschreibbarer Kalender verfügbar.', 'error');
    return;
  }

  document.getElementById('import-dialog-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'import-dialog-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <div class="modal-header">
        <h3 class="modal-title" id="import-dialog-title">ICS importieren</h3>
        <button class="icon-btn" id="import-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="margin-bottom: 14px; line-height: 1.5;">
          <strong>${escHtml(fileName)}</strong> enthält ${eventCount} Termin${eventCount === 1 ? '' : 'e'}.
        </p>
        <div class="form-group">
          <label class="fs-label" for="import-cal-select">Zielkalender</label>
          <select id="import-cal-select" class="form-input">
            ${writableCals.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-top: 12px;">
          <label class="fs-label" for="import-strategy-select">Konflikt- & Duplikat-Handhabung</label>
          <select id="import-strategy-select" class="form-input">
            <option value="SKIP" selected>Duplikate überspringen (Empfohlen)</option>
            <option value="OVERWRITE">Existierende Termine überschreiben</option>
            <option value="CREATE_NEW">Als neue Kopie anlegen</option>
          </select>
        </div>
        <div style="display: flex; gap: 10px; margin-top: 18px;">
          <button type="button" class="btn btn-primary" id="import-confirm" style="flex: 1;">Importieren</button>
          <button type="button" class="btn btn-ghost" id="import-cancel" style="flex: 1;">Abbrechen</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  openDialog(backdrop);
  const close = () => { closeDialog(backdrop); backdrop.remove(); };
  backdrop.querySelector('#import-close').addEventListener('click', close);
  backdrop.querySelector('#import-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#import-confirm').addEventListener('click', async () => {
    const calId = backdrop.querySelector('#import-cal-select').value;
    const strategy = backdrop.querySelector('#import-strategy-select').value;
    const btn = backdrop.querySelector('#import-confirm');
    btn.disabled = true;
    btn.textContent = 'Importiere…';
    try {
      const result = await CalendarsAPI.importICS(calId, icsText, null, strategy);
      close();
      const parts = [`${result.imported} importiert`];
      if (result.skipped) parts.push(`${result.skipped} übersprungen`);
      if (result.failed) parts.push(`${result.failed} fehlgeschlagen`);
      showToast(`Import abgeschlossen: ${parts.join(', ')}.`, result.failed ? 'error' : 'success');
      invalidateEventCache();
      loadEvents();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Importieren';
      showToast(err.message, 'error');
    }
  });
}

function openEditCalendarDialog(cal) {
  document.getElementById('edit-cal-dialog-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'edit-cal-dialog-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="edit-cal-dialog-title">
      <div class="modal-header">
        <h3 class="modal-title" id="edit-cal-dialog-title">Kalender bearbeiten</h3>
        <button class="icon-btn" id="edit-cal-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <form id="edit-cal-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="edit-cal-name">Name</label>
            <input class="form-input" id="edit-cal-name" type="text"
                   value="${escHtml(cal.name)}" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-cal-color">Farbe</label>
            <input class="form-input" id="edit-cal-color" type="color"
                   value="${cal.color || '#007080'}"
                   style="height:40px;padding:4px 8px;cursor:pointer;" />
          </div>
          <div id="edit-cal-error" class="form-error hidden"></div>
          <div class="modal-actions">
            <div class="modal-actions-right">
              <button type="button" class="btn btn-ghost" id="edit-cal-cancel">Abbrechen</button>
              <button type="submit" class="btn btn-primary" id="edit-cal-submit">
                <span class="btn-label">Speichern</span>
                <span class="btn-spinner hidden"></span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  openDialog(backdrop);
  const close = () => { closeDialog(backdrop); backdrop.remove(); };
  backdrop.querySelector('#edit-cal-close').addEventListener('click', close);
  backdrop.querySelector('#edit-cal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  setTimeout(() => {
    const nameInput = document.getElementById('edit-cal-name');
    nameInput?.focus();
    nameInput?.select();
  }, 50);

  backdrop.querySelector('#edit-cal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name  = document.getElementById('edit-cal-name').value.trim();
    const color = document.getElementById('edit-cal-color').value;

    if (!name) {
      const err = document.getElementById('edit-cal-error');
      err.textContent = 'Name darf nicht leer sein.';
      err.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('edit-cal-submit');
    btn.querySelector('.btn-label').style.display = 'none';
    btn.querySelector('.btn-spinner').classList.remove('hidden');
    btn.disabled = true;

    try {
      await CalendarsAPI.update(cal.id, { name, color });
      // Optimistic update in store
      const cals = store.get('calendars').map(c =>
        c.id === cal.id ? { ...c, name, color } : c
      );
      store.set({ calendars: cals });
      close();
      showToast(`Kalender umbenannt in „${name}“.`, 'success');
      renderCalendarList();
      renderCalendarView();
    } catch (err) {
      const errEl = document.getElementById('edit-cal-error');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      btn.querySelector('.btn-label').style.display = '';
      btn.querySelector('.btn-spinner').classList.add('hidden');
      btn.disabled = false;
    }
  });
}

function openShareCalendarDialog(cal) {
  document.getElementById('share-cal-dialog-backdrop')?.remove();

  const account = store.get('accounts').find(a => a.id === cal.accountId);
  const isOAuth = account && account.authType === 'oauth2';
  const serverHost = account ? new URL(account.url).host : '';

  let caldavSharingHtml = '';
  if (isOAuth) {
    caldavSharingHtml = `
      <!-- Section 1: CalDAV Sharing Excluded -->
      <div class="share-section" style="border-top:none;margin-top:0;padding-top:0;">
        <h4 class="share-section-title">Mit anderen Nutzer*innen teilen (CalDAV)</h4>
        <div style="background: rgba(234, 67, 53, 0.06); color: #d93025; padding: 12px 14px; border-radius: var(--radius-control); font-size: 0.8rem; line-height: 1.45; border: 1px solid rgba(234, 67, 53, 0.15); margin-top: 8px;">
          <strong>Teilen nicht möglich:</strong> Dieser Kalender wird über einen externen Server (${escHtml(serverHost)}) gehostet. Das direkte CalDAV-Teilen funktioniert nur mit Nutzer*innen auf demselben CalDAV-Server. Nutze stattdessen unten die öffentliche Link-Freigabe.
        </div>
      </div>
    `;
  } else {
    caldavSharingHtml = `
      <!-- Section 1: CalDAV Sharing -->
      <div class="share-section" style="border-top:none;margin-top:0;padding-top:0;">
        <h4 class="share-section-title">Mit anderen Nutzer*innen teilen (CalDAV)</h4>
        <p class="share-section-desc">Gib die E-Mail-Adresse oder den Namen einer Person auf dem CalDAV-Server (${escHtml(serverHost)}) ein, um sie einzuladen.</p>
        
        <div class="share-input-row">
          <div class="autocomplete-container">
            <input class="form-input" id="share-search-input" type="text" placeholder="Personen/Nutzer*innen suchen oder E-Mail eingeben..." autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="share-autocomplete-dropdown" aria-haspopup="listbox" />
            <div class="autocomplete-dropdown hidden" id="share-autocomplete-dropdown" role="listbox" aria-label="Nutzer-Vorschläge"></div>
          </div>
          <select class="form-select" id="share-role-select" style="width:140px; flex-shrink:0;">
            <option value="false">Nur Lesen</option>
            <option value="true" selected>Lesen & Schreiben</option>
          </select>
          <button class="btn btn-primary" id="share-add-btn" style="flex-shrink:0;">Hinzufügen</button>
        </div>
        
        <div class="share-list" id="share-list-container">
          <div style="font-size:0.8rem;color:var(--ink-muted);padding:8px;text-align:center;">Lade Freigaben...</div>
        </div>
      </div>
    `;
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'share-cal-dialog-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="share-cal-dialog-title" style="max-width:560px;">
      <div class="modal-header">
        <h3 class="modal-title" id="share-cal-dialog-title">Freigabe & Sharing: ${escHtml(cal.name)}</h3>
        <button class="icon-btn" id="share-cal-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        
        ${caldavSharingHtml}

        <!-- Section 2: Public ICS Sharing -->
        <div class="share-section">
          <h4 class="share-section-title">Abonnement-Link (ICS / Webcal)</h4>
          <p class="share-section-desc">Ermöglicht anderen Kalendern (z. B. Google, Outlook, Thunderbird), diesen Kalender schreibgeschützt zu abonnieren.</p>
          
          <div class="form-group" style="margin-bottom: var(--sp-2);">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="public-link-enable" />
              <span>Link-Freigabe aktivieren</span>
            </label>
          </div>

          <div class="public-link-container hidden" id="public-link-area">
            <input class="form-input" id="public-link-input" type="text" readonly style="background:var(--bg);" />
            <button class="btn btn-secondary" id="public-link-copy-btn">Kopieren</button>
            <button class="btn btn-ghost" id="public-link-regen-btn" title="Link neu generieren (alter Link verfällt)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/>
              </svg>
            </button>
          </div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(backdrop);
  openDialog(backdrop);
  const close = () => { closeDialog(backdrop); backdrop.remove(); };
  backdrop.querySelector('#share-cal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const publicEnable = backdrop.querySelector('#public-link-enable');
  const publicArea   = backdrop.querySelector('#public-link-area');
  const publicInput  = backdrop.querySelector('#public-link-input');
  const publicCopy   = backdrop.querySelector('#public-link-copy-btn');
  const publicRegen  = backdrop.querySelector('#public-link-regen-btn');

  if (!isOAuth) {
    const searchInput = backdrop.querySelector('#share-search-input');
    const autocompleteDropdown = backdrop.querySelector('#share-autocomplete-dropdown');
    const addBtn = backdrop.querySelector('#share-add-btn');
    const roleSelect = backdrop.querySelector('#share-role-select');
    const listContainer = backdrop.querySelector('#share-list-container');

    addBtn.addEventListener('click', async () => {
      const sharee = searchInput.value.trim();
      if (!sharee) {
        showToast('Bitte wähle eine/n Nutzer*in oder eine E-Mail-Adresse.', 'warning');
        return;
      }
      const readWrite = roleSelect.value === 'true';
      try {
        addBtn.disabled = true;
        await CalendarsAPI.addShare(cal.id, sharee, readWrite);
        showToast('Freigabe-Einladung gesendet.', 'success');
        searchInput.value = '';
        loadShares();
      } catch (e) {
        showToast('Einladung fehlgeschlagen: ' + e.message, 'error');
      } finally {
        addBtn.disabled = false;
      }
    });

    let searchTimeout = null;
    let activeIndex = -1;

    function hideDropdown() {
      autocompleteDropdown.classList.add('hidden');
      searchInput.setAttribute('aria-expanded', 'false');
      searchInput.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    }

    function showDropdown() {
      autocompleteDropdown.classList.remove('hidden');
      searchInput.setAttribute('aria-expanded', 'true');
    }

    function updateActiveOption(items) {
      items.forEach((item, idx) => {
        const isActive = idx === activeIndex;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          searchInput.setAttribute('aria-activedescendant', item.id);
          if (typeof item.scrollIntoView === 'function') {
            item.scrollIntoView({ block: 'nearest' });
          }
        }
      });
      if (activeIndex < 0) {
        searchInput.removeAttribute('aria-activedescendant');
      }
    }

    searchInput.addEventListener('keydown', e => {
      const items = Array.from(autocompleteDropdown.querySelectorAll('.autocomplete-item'));
      const isVisible = !autocompleteDropdown.classList.contains('hidden') && items.length > 0;

      if (e.key === 'ArrowDown') {
        if (!isVisible) return;
        e.preventDefault();
        activeIndex = (activeIndex + 1) % items.length;
        updateActiveOption(items);
      } else if (e.key === 'ArrowUp') {
        if (!isVisible) return;
        e.preventDefault();
        activeIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
        updateActiveOption(items);
      } else if (e.key === 'Enter') {
        if (isVisible && activeIndex >= 0 && activeIndex < items.length) {
          e.preventDefault();
          e.stopPropagation();
          searchInput.value = items[activeIndex].dataset.value;
          hideDropdown();
        }
      } else if (e.key === 'Escape') {
        if (isVisible) {
          e.preventDefault();
          e.stopPropagation();
          hideDropdown();
        }
      }
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const q = searchInput.value.trim();
      if (q.length < 2) {
        hideDropdown();
        return;
      }

      searchTimeout = setTimeout(async () => {
        try {
          const users = await CalendarsAPI.searchUsers(q, cal.accountId);
          if (users.length === 0) {
            hideDropdown();
            return;
          }

          autocompleteDropdown.innerHTML = users.map((u, idx) => `
            <div class="autocomplete-item" id="share-opt-${idx}" role="option" aria-selected="false" data-value="${escHtml(u.href || u.email)}">
              <strong>${escHtml(u.displayname)}</strong> (${escHtml(u.email || u.href)})
            </div>
          `).join('');

          activeIndex = -1;
          showDropdown();

          const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
          items.forEach((item, idx) => {
            item.addEventListener('click', () => {
              searchInput.value = item.dataset.value;
              hideDropdown();
            });
            item.addEventListener('mouseenter', () => {
              activeIndex = idx;
              updateActiveOption(items);
            });
          });
        } catch (e) {
          console.error('User search failed:', e);
        }
      }, 300);
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.autocomplete-container')) {
        hideDropdown();
      }
    });

    async function loadShares() {
      listContainer.innerHTML = '<div style="font-size:0.8rem;color:var(--ink-muted);padding:8px;text-align:center;">Lade...</div>';
      try {
        const res = await CalendarsAPI.getShares(cal.id);
        const shares = res.shares || [];
        if (shares.length === 0) {
          listContainer.innerHTML = '<div style="font-size:0.8rem;color:var(--ink-muted);padding:12px;text-align:center;">Dieser Kalender ist aktuell mit niemandem geteilt.</div>';
          return;
        }
        
        listContainer.innerHTML = shares.map(s => {
          const badgeClass = s.status === 'ACCEPTED' ? 'accepted' : s.status === 'DECLINED' ? 'declined' : 'pending';
          const badgeLabel = s.status === 'ACCEPTED' ? 'aktiv' : s.status === 'DECLINED' ? 'abgelehnt' : 'ausstehend';

          let displayHref = s.href;
          if (displayHref.startsWith('principal:')) {
            const parts = displayHref.split('/');
            displayHref = parts[parts.length - 1] || displayHref;
          }

          return `
            <div class="share-user-item">
              <div class="share-user-info">
                <span class="share-user-name">${escHtml(s.commonName || displayHref)}</span>
                <span class="share-user-email">${escHtml(displayHref)}</span>
              </div>
              <div class="share-user-actions">
                <select class="form-select share-role-toggle" data-href="${escHtml(s.href)}" style="font-size:11px; padding: 2px 20px 2px 4px; width: auto; height: auto; flex-shrink: 0; cursor: pointer; border: 1px solid var(--border); border-radius: 4px; background-color: transparent; color: var(--ink);">
                  <option value="false" ${!s.readWrite ? 'selected' : ''}>Lesen</option>
                  <option value="true" ${s.readWrite ? 'selected' : ''}>Schreiben</option>
                </select>
                <span class="share-badge ${badgeClass}">${badgeLabel}</span>
                <button class="icon-btn cal-action-delete btn-revoke-share" data-href="${escHtml(s.href)}" title="Entfernen" style="padding:4px;">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                  </svg>
                </button>
              </div>
            </div>`;
        }).join('');

        listContainer.querySelectorAll('.share-role-toggle').forEach(select => {
          select.addEventListener('change', async () => {
            const href = select.dataset.href;
            const readWrite = select.value === 'true';
            try {
              select.disabled = true;
              await CalendarsAPI.addShare(cal.id, href, readWrite);
              showToast('Freigaberechte aktualisiert.', 'success');
              loadShares();
            } catch (e) {
              showToast('Rechte-Aktualisierung fehlgeschlagen: ' + e.message, 'error');
              select.disabled = false;
              select.value = (!readWrite).toString();
            }
          });
        });

        listContainer.querySelectorAll('.btn-revoke-share').forEach(btn => {
          btn.addEventListener('click', async () => {
            const href = btn.dataset.href;
            if (!(await confirmDialog(`Freigabe für „${href}“ entziehen?`))) return;
            try {
              btn.disabled = true;
              await CalendarsAPI.removeShare(cal.id, href);
              showToast('Freigabe entfernt.', 'info');
              loadShares();
            } catch (e) {
              showToast('Fehler: ' + e.message, 'error');
              btn.disabled = false;
            }
          });
        });

      } catch (e) {
        listContainer.innerHTML = `<div style="font-size:0.8rem;color:var(--danger);padding:8px;text-align:center;">Ladefehler: ${escHtml(e.message)}</div>`;
      }
    }

    loadShares();
  }

  let publicLinkSeq = 0;

  async function loadPublicLink() {
    const seq = ++publicLinkSeq;
    try {
      const data = await CalendarsAPI.getPublicLink(cal.id);
      if (seq !== publicLinkSeq) return;
      if (data.enabled) {
        publicEnable.checked = true;
        publicArea.classList.remove('hidden');
        publicInput.value = data.url;
      } else {
        publicEnable.checked = false;
        publicArea.classList.add('hidden');
        publicInput.value = '';
      }
    } catch (e) {
      if (seq !== publicLinkSeq) return;
      console.error('Failed to load public link status:', e);
    }
  }

  publicEnable.addEventListener('change', async () => {
    const seq = ++publicLinkSeq;
    const targetState = publicEnable.checked;
    try {
      if (targetState) {
        const data = await CalendarsAPI.enablePublicLink(cal.id);
        if (seq !== publicLinkSeq) return;
        publicArea.classList.remove('hidden');
        publicInput.value = data.url;
        showToast('Öffentlicher Link aktiviert.', 'success');
      } else {
        await CalendarsAPI.disablePublicLink(cal.id);
        if (seq !== publicLinkSeq) return;
        publicArea.classList.add('hidden');
        publicInput.value = '';
        showToast('Öffentlicher Link deaktiviert.', 'info');
      }
    } catch (e) {
      if (seq !== publicLinkSeq) return;
      showToast('Änderung fehlgeschlagen: ' + e.message, 'error');
      publicEnable.checked = !targetState;
    }
  });

  publicCopy.addEventListener('click', () => {
    publicInput.select();
    navigator.clipboard.writeText(publicInput.value)
      .then(() => showToast('Link in Zwischenablage kopiert!', 'success'))
      .catch(() => showToast('Kopieren fehlgeschlagen.', 'error'));
  });

  publicRegen.addEventListener('click', async () => {
    if (!(await confirmDialog('Bestehenden Link wirklich ungültig machen und neuen Link generieren?'))) return;
    const seq = ++publicLinkSeq;
    try {
      const data = await CalendarsAPI.enablePublicLink(cal.id);
      if (seq !== publicLinkSeq) return;
      publicInput.value = data.url;
      showToast('Neuer Freigabe-Link generiert.', 'success');
    } catch (e) {
      if (seq !== publicLinkSeq) return;
      showToast('Regenerierung fehlgeschlagen: ' + e.message, 'error');
    }
  });

  loadPublicLink();
}

function renderSettings() {
  renderSettingsAccounts();
  renderSettingsCalendars();
  renderSettingsAppPasswords();
  renderSettingsTimezone();
}

function renderSettingsTimezone() {
  const showToggle      = $('show-secondary-tz-toggle');
  const priSelect       = $('primary-tz-select');
  const secSelect       = $('secondary-tz-select');
  const headerSecSelect = $('header-secondary-tz-select');

  const currentSecTz = store.get('secondaryTimezone') || '';

  if (showToggle) showToggle.checked = store.get('showSecondaryTimezone') === true || Boolean(currentSecTz);
  if (priSelect)  priSelect.value  = store.get('primaryTimezone') || 'Europe/Berlin';
  if (secSelect)  secSelect.value  = currentSecTz;
  if (headerSecSelect) headerSecSelect.value = currentSecTz;
}

async function renderSettingsAppPasswords() {
  const list = $('settings-asp-list');
  if (!list) return;

  try {
    list.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">Lade App-Passwörter...</div>';
    const listData = await AccountsAPI.listAppPasswords();
    if (!listData.length) {
      list.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">Keine App-Passwörter eingerichtet.</div>';
      return;
    }

    list.innerHTML = listData.map(asp => {
      const dateStr = new Date(asp.createdAt).toLocaleDateString('de-DE');
      return `
        <div class="settings-item" style="padding: 6px 0">
          <div class="settings-item-info" style="display:flex; flex-direction:column; align-items:flex-start">
            <span style="font-weight: 500">${escHtml(asp.label)}</span>
            <span style="font-size: 10px; color:var(--ink-muted)">Erstellt am ${dateStr}</span>
          </div>
          <div class="settings-item-actions">
            <button class="settings-action-btn btn-danger" data-delete-asp="${escHtml(asp.id)}" title="Passwort löschen" style="padding:4px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              </svg>
            </button>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-delete-asp]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteAsp;
        if (!(await confirmDialog('Dieses App-Passwort wirklich löschen? Externe Clients mit diesem Passwort verlieren den Zugriff.'))) return;
        try {
          await AccountsAPI.removeAppPassword(id);
          showToast('App-Passwort gelöscht.', 'info');
          renderSettingsAppPasswords();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

  } catch (err) {
    list.innerHTML = `<div style="font-size:0.75rem;color:var(--danger);padding:4px">Ladefehler: ${escHtml(err.message)}</div>`;
  }
}

function renderSettingsAccounts() {
  const list = $('settings-account-list');
  if (!list) return;
  const accounts = store.get('accounts');

  if (!accounts.length) {
    list.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">Keine Accounts eingerichtet.</div>';
    return;
  }

  const errors = store.get('accountErrors') || [];

  list.innerHTML = accounts.map(a => {
    const isEnvDefault = a.id === 'env-default';
    const errObj = errors.find(e => e.accountId === a.id);
    const hasError = !!errObj;

    const reconnectBtn = (hasError && a.url.includes('googleusercontent.com'))
      ? `<button class="settings-action-btn" data-reconnect-acc="${escHtml(a.id)}" title="Verbindung wiederherstellen" style="color:var(--warning, #f59e0b)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/>
          </svg>
         </button>`
      : '';

    const editBtn = isEnvDefault
      ? ''
      : `<button class="settings-action-btn" data-edit-acc="${escHtml(a.id)}" title="Umbenennen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
         </button>`;

    const deleteBtn = isEnvDefault
      ? ''
      : `<button class="settings-action-btn btn-danger" data-delete-acc="${escHtml(a.id)}" title="Account entfernen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
         </button>`;

    const errorHtml = hasError
      ? `<div style="color:var(--danger, #ef4444); font-size:0.68rem; margin-top:2px; display:flex; align-items:center; gap:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="flex-shrink:0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>
          </svg>
          Verbindungsfehler
         </div>`
      : '';

    return `
      <div class="settings-item">
        <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
          <div class="settings-item-info">
            <div class="account-dot" style="width:8px; height:8px; border-radius:50%; background:var(--line); flex-shrink:0"></div>
            <span class="settings-item-name" title="${escHtml(a.url)}">${escHtml(a.displayName || a.username)}</span>
          </div>
          ${errorHtml}
        </div>
        <div class="settings-item-actions">
          ${reconnectBtn}
          ${editBtn}
          ${deleteBtn}
        </div>
      </div>`;
  }).join('');

  // Edit Account
  list.querySelectorAll('[data-edit-acc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.editAcc;
      const acc = accounts.find(a => a.id === id);
      if (!acc) return;
      const newName = prompt('Neuer Name für diesen Account:', acc.displayName || acc.username);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed) return;
      try {
        await AccountsAPI.update(id, { displayName: trimmed });
        const updated = store.get('accounts').map(a => a.id === id ? { ...a, displayName: trimmed } : a);
        store.set({ accounts: updated });
        showToast('Account umbenannt.', 'success');
        renderSidebar();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Delete Account
  list.querySelectorAll('[data-delete-acc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteAcc;
      const acc = accounts.find(a => a.id === id);
      if (!acc) return;
      if (!(await confirmDialog(`Möchtest du den Account „${acc.displayName || acc.username}“ wirklich entfernen? Alle zugehörigen Kalender werden ausgeblendet.`))) return;
      try {
        await AccountsAPI.remove(id);
        const updated = store.get('accounts').filter(a => a.id !== id);
        store.set({ accounts: updated });
        showToast('Account entfernt.', 'info');
        if (updated.length === 0) {
          $('settings-drawer').classList.remove('open');
          showOnboarding();
        } else {
          renderSidebar();
          await loadCalendars();
          await loadEvents();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Reconnect Account
  list.querySelectorAll('[data-reconnect-acc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const width = 500, height = 600;
      const left = (window.screen.width / 2) - (width / 2);
      const top = (window.screen.height / 2) - (height / 2);
      const popup = window.open(
        '/api/auth/google',
        'Google OAuth Reconnect',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
      );
      if (popup) popup.focus();
    });
  });
}

function renderSettingsCalendars() {
  const list = $('settings-calendar-list');
  if (!list) return;
  const cals = store.get('calendars');

  if (!cals.length) {
    list.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">Keine Kalender gefunden.</div>';
    return;
  }

  list.innerHTML = cals.map(c => {
    const deleteBtn = (c.isShared || c.readOnly || c.id.includes('env-default'))
      ? ''
      : `<button class="settings-action-btn btn-danger" data-delete-cal-settings="${escHtml(c.id)}" title="Kalender löschen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
         </button>`;

    const googleBadge = c.source === 'google'
      ? `<svg class="google-badge-icon" viewBox="0 0 24 24" width="12" height="12" style="flex-shrink:0;" title="Mit Google Kalender synchronisiert">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"/>
         </svg>`
      : '';

    return `
      <div class="settings-item">
        <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
          <div class="settings-item-info">
            <div class="calendar-dot" style="background:${escHtml(sanitizeColor(c.color))}; width:8px; height:8px; border-radius:50%; flex-shrink:0"></div>
            <span class="settings-item-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
            ${googleBadge}
          </div>
        </div>
        <div class="settings-item-actions">
          ${deleteBtn}
        </div>
      </div>`;
  }).join('');

  // Delete Calendar from Settings
  list.querySelectorAll('[data-delete-cal-settings]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteCalSettings;
      const cal = cals.find(c => c.id === id);
      if (!cal) return;
      if (!(await confirmDialog(`Kalender „${cal.name}“ und alle darin enthaltenen Termine unwiderruflich löschen?`))) return;
      try {
        await CalendarsAPI.remove(id);
        store.set({ calendars: store.get('calendars').filter(c => c.id !== id) });
        showToast(`Kalender „${cal.name}“ gelöscht.`, 'info');
        invalidateEventCache();
        await loadEvents();
        renderSidebar();
        renderCalendarView();
      } catch (err) {
        showToast('Fehler: ' + err.message, 'error');
      }
    });
  });
}

// ── Add Calendar Dialog ───────────────────────────────────────────────────────

function openAddCalendarDialog() {
  // Remove any existing dialog first
  document.getElementById('add-cal-dialog-backdrop')?.remove();

  const accounts = store.get('accounts');
  if (!accounts.length) {
    showToast('Bitte zuerst einen Account hinzufügen.', 'error');
    return;
  }

  const accountOptions = accounts.map(a =>
    `<option value="${escHtml(a.id)}">${escHtml(a.displayName || a.username)}</option>`
  ).join('');

  const backdrop = document.createElement('div');
  backdrop.id = 'add-cal-dialog-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="add-cal-dialog-title">
      <div class="modal-header">
        <h3 class="modal-title" id="add-cal-dialog-title">Neuer Kalender</h3>
        <button class="icon-btn modal-close" id="add-cal-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <form id="add-cal-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="add-cal-name">Name</label>
            <input class="form-input" id="add-cal-name" type="text" placeholder="Mein Kalender" required autofocus />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="add-cal-color">Farbe</label>
              <input class="form-input" id="add-cal-color" type="color" value="#7c3aed"
                     style="height:40px;padding:4px 8px;cursor:pointer;" />
            </div>
            <div class="form-group">
              <label class="form-label" for="add-cal-account">Account</label>
              <select class="form-select" id="add-cal-account">${accountOptions}</select>
            </div>
          </div>
          <div id="add-cal-error" class="form-error hidden"></div>
          <div class="modal-actions">
            <div class="modal-actions-right">
              <button type="button" class="btn btn-ghost" id="add-cal-cancel">Abbrechen</button>
              <button type="submit" class="btn btn-primary" id="add-cal-submit">
                <span class="btn-label">Erstellen</span>
                <span class="btn-spinner hidden"></span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const closeDialog = () => backdrop.remove();

  backdrop.querySelector('#add-cal-close').addEventListener('click', closeDialog);
  backdrop.querySelector('#add-cal-cancel').addEventListener('click', closeDialog);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeDialog(); });

  backdrop.querySelector('#add-cal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name      = document.getElementById('add-cal-name').value.trim();
    const color     = document.getElementById('add-cal-color').value;
    const accountId = document.getElementById('add-cal-account').value;

    if (!name) {
      const err = document.getElementById('add-cal-error');
      err.textContent = 'Bitte einen Namen eingeben.';
      err.classList.remove('hidden');
      return;
    }

    const submitBtn = document.getElementById('add-cal-submit');
    submitBtn.querySelector('.btn-label').style.display = 'none';
    submitBtn.querySelector('.btn-spinner').classList.remove('hidden');
    submitBtn.disabled = true;

    try {
      await CalendarsAPI.create({ accountId, name, color });
      closeDialog();
      showToast(`Kalender „${name}“ erstellt.`, 'success');
      await loadCalendars();
      renderSidebar();
      renderCalendarView();
    } catch (err) {
      const errEl = document.getElementById('add-cal-error');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      submitBtn.querySelector('.btn-label').style.display = '';
      submitBtn.querySelector('.btn-spinner').classList.add('hidden');
      submitBtn.disabled = false;
    }
  });

  setTimeout(() => document.getElementById('add-cal-name')?.focus(), 50);
}

// ── Event Popover ─────────────────────────────────────────────────────────────

let _popoverUid = null;
const calendarsById = () => {
  const map = {};
  (store.get('calendars') || []).forEach(c => map[c.id] = c);
  return map;
};

function showEventPopover(ev, mouseEvent) {
  const popover = $('event-popover');
  const cal     = calendarsById()[ev.calendarId] || {};
  const color   = cal.color || '#6366f1';

  const timeStr = ev.allDay
    ? 'Ganztägig'
    : `${fmt(ev.start)} – ${fmt(ev.end)}`;

  const attHtml = ev.attendees?.length
    ? `<div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <span>${ev.attendees.map(a => escHtml(a.name || a.email)).join(', ')}</span>
       </div>`
    : '';

  const attachHtml = (Array.isArray(ev.attachments) && ev.attachments.length > 0)
    ? `<div class="popover-row popover-attachments" id="popover-attachments">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        <div style="display:flex; flex-direction:column; gap:2px;">
          ${ev.attachments.map(a => `
            <a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="attachment-drive-link" style="color:var(--accent); font-size:12px; text-decoration:underline;">${escHtml(a.name || a.url)}</a>
          `).join('')}
        </div>
       </div>`
    : '';

  const actionsHtml = cal.readOnly
    ? `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Details</button>
       <span style="font-size:11px;color:var(--danger);margin-left:auto;padding-right:8px;font-weight:600;">Schreibgeschützt</span>`
    : `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Bearbeiten</button>
       <button class="btn btn-ghost btn-sm btn-danger" id="popover-delete-btn">Löschen</button>`;

  popover.innerHTML = `
    <div class="popover-color-bar" style="background:${escHtml(sanitizeColor(color))}"></div>
    <div class="popover-title">${escHtml(ev.title)}</div>
    <div class="popover-meta">
      <div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <span>${timeStr}</span>
      </div>
      ${ev.location ? `<div class="popover-row popover-location">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        <span>${escHtml(ev.location)}</span>
      </div>` : ''}
      ${ev.description ? `<div class="popover-row popover-description" style="margin-top:4px; font-size:12px; color:var(--text-muted);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
        <span>${escHtml(ev.description)}</span>
      </div>` : ''}
      ${attHtml}
      ${attachHtml}
    </div>
    <div class="popover-actions">
      ${actionsHtml}
    </div>`;

  // Position near mouse or target element if keyboard activated
  popover.classList.remove('hidden');
  _popoverUid = ev.uid;

  let mouseX = mouseEvent && typeof mouseEvent.clientX === 'number' && mouseEvent.clientX > 0 ? mouseEvent.clientX : null;
  let mouseY = mouseEvent && typeof mouseEvent.clientY === 'number' && mouseEvent.clientY > 0 ? mouseEvent.clientY : null;
  if (mouseX === null && mouseEvent && mouseEvent.target && typeof mouseEvent.target.getBoundingClientRect === 'function') {
    const tRect = mouseEvent.target.getBoundingClientRect();
    mouseX = tRect.left;
    mouseY = tRect.bottom;
  }
  if (mouseX === null) {
    mouseX = (typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - 150;
    mouseY = (typeof window !== 'undefined' ? window.innerHeight : 600) / 2 - 100;
  }

  const winH = typeof window !== 'undefined' ? window.innerHeight : 600;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 800;
  let top  = mouseY + 10;
  let left = mouseX + 10;
  if (top  + 200 > winH) top  = mouseY - 220;
  if (left + 300 > winW) left = mouseX - 300;
  popover.style.top  = `${Math.max(10, top)}px`;
  popover.style.left = `${Math.max(10, left)}px`;

  const editBtn = $('popover-edit-btn');
  if (editBtn) {
    editBtn.onclick = () => {
      closePopover();
      openEditModal(ev, { onSaved: onEventSaved, onDeleted: onEventDeleted });
    };
    if (typeof editBtn.focus === 'function') editBtn.focus();
  }

  const deleteBtn = $('popover-delete-btn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      let scope = 'series';
      if (ev.recurrenceId) {
        scope = await chooseRecurrenceScope(`„${ev.title}“ löschen:`);
        if (!scope) return;
      } else {
        if (!(await confirmDialog(`„${ev.title}“ löschen?`))) return;
      }
      try {
        const targetUid = ev.masterUid || ev.uid;
        await EventsAPI.remove(targetUid, {
          calendarId: ev.calendarId, etag: ev.etag, href: ev.href,
          ...(scope === 'occurrence' ? { scope, recurrenceId: ev.recurrenceId } : {})
        });
        closePopover();
        onEventDeleted(targetUid);
        showToast('Termin gelöscht.', 'info');
      } catch(err) { showToast(err.message, 'error'); }
    };
  }
}

function closePopover() {
  $('event-popover').classList.add('hidden');
  _popoverUid = null;
}

// ── Event callbacks ───────────────────────────────────────────────────────────

function onEventSaved(savedEvent) {
  invalidateEventCache();
  loadEvents();
}

function onEventDeleted(uid) {
  invalidateEventCache();
  loadEvents();
}

// ── UI Event Listeners ────────────────────────────────────────────────────────

function attachListeners() {
  const reauthBtn = $('oauth-reauth-btn');
  if (reauthBtn) {
    reauthBtn.addEventListener('click', () => {
      const width = 600;
      const height = 650;
      const left = (window.screen.width - width) / 2;
      const top = (window.screen.height - height) / 2;
      const popup = window.open(
        '/api/auth/google',
        'google-oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
      );
      if (popup) popup.focus();
    });
  }

  function switchView(viewName) {
    document.querySelectorAll('.view-tab').forEach(b => {
      const isActive = b.dataset.view === viewName;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    store.set({ view: viewName });
    const viewLabels = {
      month: 'Monatsansicht',
      week: 'Wochenansicht',
      workweek: 'Arbeitswoche',
      day: 'Tagesansicht',
      agenda: 'Agendaansicht',
      kanban: 'Kanban-Ansicht'
    };
    const label = viewLabels[viewName] || viewName;
    announce(`Ansicht gewechselt: ${label}`);
    loadEvents();
  }

  function renderShortcutsHelp() {
    const container = $('shortcuts-list');
    if (!container || typeof Shortcuts === 'undefined') return;
    const list = Shortcuts.getShortcutHelpList();
    container.innerHTML = list.map(item => `
      <div class="shortcut-row">
        <span class="shortcut-desc">${escHtml(item.desc)}</span>
        <span class="shortcut-key"><kbd class="shortcut-badge">${escHtml(item.key)}</kbd></span>
      </div>
    `).join('');
  }

  // View switcher
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
    });
  });

  // Navigation
  $('prev-btn').addEventListener('click', () => {
    const newDate = navigate(store.get('view'), store.get('currentDate'), -1);
    store.set({ currentDate: newDate });
    loadEvents();
    announce(`Datum: ${getToolbarTitle(store.get('view'), newDate)}`);
  });
  $('next-btn').addEventListener('click', () => {
    const newDate = navigate(store.get('view'), store.get('currentDate'), 1);
    store.set({ currentDate: newDate });
    loadEvents();
    announce(`Datum: ${getToolbarTitle(store.get('view'), newDate)}`);
  });
  $('today-btn').addEventListener('click', () => {
    const t = new Date(); t.setHours(0,0,0,0);
    store.set({ currentDate: t });
    loadEvents();
    announce(`Datum: ${getToolbarTitle(store.get('view'), t)}`);
  });

  const exportPdfBtn = $('export-pdf-btn');
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', async () => {
      const view = store.get('view');
      const currentDate = store.get('currentDate') || new Date();
      const events = getFilteredEvents();
      const exportView = (view === 'week' || view === 'workweek') ? 'week' : 'month';

      try {
        const res = await fetch('/api/calendars/export/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            view: exportView,
            year: currentDate.getFullYear(),
            month: currentDate.getMonth() + 1,
            events: events,
            title: $('toolbar-title').textContent || 'Calendar Export',
            orientation: 'landscape'
          })
        });

        if (!res.ok) throw new Error('PDF export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `calendar-${exportView}-${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[PDF Export Error]', err);
        window.print();
      }
    });
  }


  // New event button
  $('new-event-btn').addEventListener('click', () => {
    openCreateModal(store.get('currentDate') || new Date(), { onSaved: onEventSaved, onDeleted: onEventDeleted });
  });

  // Settings Drawer Toggle
  $('sidebar-settings-btn').addEventListener('click', () => {
    openDialog($('settings-drawer'));
    renderSettings();
  });
  $('close-settings-btn').addEventListener('click', () => {
    closeDialog($('settings-drawer'));
  });

  // Add account from settings
  $('settings-add-account-btn').addEventListener('click', () => {
    openAccountModal({ onAdded: async () => {
      const accounts = await AccountsAPI.list();
      store.set({ accounts });
      showApp();
      await loadCalendars();
      await loadEvents();
      renderSidebar();
    }});
  });

  // Add calendar
  $('add-calendar-btn').addEventListener('click', () => openAddCalendarDialog());
  $('settings-add-calendar-btn').addEventListener('click', () => openAddCalendarDialog());

  // Add App-Specific Password
  $('settings-add-asp-btn').addEventListener('click', async () => {
    const label = prompt('Bezeichnung für das neue App-Passwort (z. B. "Thunderbird"):');
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      const res = await AccountsAPI.addAppPassword(trimmed);
      alert(`App-Passwort erfolgreich generiert!\n\nBezeichnung: ${res.label}\nPasswort: ${res.rawPassword}\n\nBitte kopiere das Passwort JETZT. Es wird aus Sicherheitsgründen nicht noch einmal angezeigt.`);
      renderSettingsAppPasswords();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Theme / Dark Mode Settings Control
  const themeSelect = $('theme-select');
  if (themeSelect && typeof getStoredTheme === 'function') {
    themeSelect.value = getStoredTheme();
    themeSelect.addEventListener('change', e => {
      if (typeof setTheme === 'function') setTheme(e.target.value);
    });
  }

  // Timezone Settings Controls
  function updateSecondaryTimezone(tzVal) {
    const val = tzVal || null;
    if (val) {
      localStorage.setItem('secondaryTimezone', val);
      localStorage.setItem('showSecondaryTimezone', 'true');
    } else {
      localStorage.removeItem('secondaryTimezone');
      localStorage.setItem('showSecondaryTimezone', 'false');
    }
    store.set({
      secondaryTimezone: val,
      showSecondaryTimezone: Boolean(val)
    });

    const showTzToggle    = $('show-secondary-tz-toggle');
    const secTzSelect     = $('secondary-tz-select');
    const headerSecSelect = $('header-secondary-tz-select');
    if (showTzToggle) showTzToggle.checked = Boolean(val);
    if (secTzSelect) secTzSelect.value = val || '';
    if (headerSecSelect) headerSecSelect.value = val || '';

    renderCalendarView();
  }

  const showTzToggle = $('show-secondary-tz-toggle');
  if (showTzToggle) {
    showTzToggle.addEventListener('change', e => {
      const enabled = e.target.checked;
      localStorage.setItem('showSecondaryTimezone', enabled ? 'true' : 'false');
      if (!enabled) {
        updateSecondaryTimezone(null);
      } else {
        const cur = store.get('secondaryTimezone') || 'America/New_York';
        updateSecondaryTimezone(cur);
      }
    });
  }

  const priTzSelect = $('primary-tz-select');
  if (priTzSelect) {
    priTzSelect.addEventListener('change', e => {
      const tz = e.target.value;
      localStorage.setItem('primaryTimezone', tz);
      store.set({ primaryTimezone: tz });
      renderCalendarView();
    });
  }

  const secTzSelect = $('secondary-tz-select');
  if (secTzSelect) {
    secTzSelect.addEventListener('change', e => {
      updateSecondaryTimezone(e.target.value);
    });
  }

  const headerSecTzSelect = $('header-secondary-tz-select');
  if (headerSecTzSelect) {
    headerSecTzSelect.addEventListener('change', e => {
      updateSecondaryTimezone(e.target.value);
    });
  }

  if (window.WorkingHoursModule) {
    window.WorkingHoursModule.init();
  }

  // Mobile sidebar toggle
  $('menu-btn').addEventListener('click', () => $('sidebar').classList.add('open'));
  $('sidebar-toggle').addEventListener('click', () => $('sidebar').classList.remove('open'));

  // Search (inline in toolbar, no toggle needed)
  $('search-input').addEventListener('input', e => {
    store.set({ searchQuery: e.target.value });
    renderCalendarView();
  });

  // Close popover on outside click
  document.addEventListener('click', e => {
    if (_popoverUid && !e.target.closest('.event-popover') && !e.target.closest('[data-event-uid]')) {
      closePopover();
    }
  });

  // Onboarding form
  $('onboarding-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData($('onboarding-form')));
    const btn  = $('onboarding-submit');
    btn.querySelector('.btn-label').style.display = 'none';
    btn.querySelector('.btn-spinner').classList.remove('hidden');
    btn.disabled = true;
    $('onboarding-error').classList.add('hidden');

    try {
      await AccountsAPI.add(data);
      const accounts = await AccountsAPI.list();
      store.set({ accounts });
      showApp();
      await loadCalendars();
      await loadEvents();
    } catch (err) {
      const errEl = $('onboarding-error');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      btn.querySelector('.btn-label').style.display = '';
      btn.querySelector('.btn-spinner').classList.add('hidden');
      btn.disabled = false;
    }
  });

  // Onboarding Google Link
  $('btn-onboarding-link-google').addEventListener('click', () => {
    const width = 600;
    const height = 650;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;
    const popup = window.open(
      '/api/auth/google',
      'google-oauth',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
    );
    if (popup) popup.focus();
  });

  // Global Message Listener for OAuth Popups
  window.addEventListener('message', async e => {
    if (e.data === 'google-account-linked') {
      const modalBackdrop = $('account-modal-backdrop');
      if (modalBackdrop && !modalBackdrop.classList.contains('hidden')) {
        modalBackdrop.classList.add('hidden');
      }
      showToast('Google Kalender erfolgreich verknüpft!', 'success');

      const accounts = await AccountsAPI.list();
      store.set({ accounts });
      showApp();
      await loadCalendars();
      await loadEvents();
    }
  });

  // ── Keyboard Shortcuts Integration ──────────────────────────────────────────
  renderShortcutsHelp();

  const shortcutsCloseBtn = $('shortcuts-modal-close');
  if (shortcutsCloseBtn) {
    shortcutsCloseBtn.addEventListener('click', () => {
      const modal = $('shortcuts-modal-backdrop');
      if (modal) closeDialog(modal);
    });
  }

  document.addEventListener('keydown', e => {
    const isModalOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
      .some(m => !m.classList.contains('hidden'));

    const targetEl = e.target;
    const tagName = targetEl ? (targetEl.tagName || '').toUpperCase() : '';
    const role = targetEl && typeof targetEl.getAttribute === 'function' ? (targetEl.getAttribute('role') || '').toLowerCase() : '';
    const isButton = Boolean(
      targetEl && (
        tagName === 'BUTTON' ||
        tagName === 'SUMMARY' ||
        role === 'button' ||
        (typeof targetEl.closest === 'function' && targetEl.closest('button, [role="button"], summary') !== null)
      )
    );
    const isEditable = Boolean(
      targetEl && (
        targetEl.isContentEditable ||
        (typeof targetEl.getAttribute === 'function' && targetEl.getAttribute('contenteditable') === 'true') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)
      )
    );

    const eventPayload = {
      key: e.key,
      targetTagName: tagName,
      targetRole: role,
      isTargetEditable: isEditable,
      isTargetButton: isButton,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    };

    const action = typeof Shortcuts !== 'undefined'
      ? Shortcuts.parseShortcutAction(eventPayload, isModalOpen)
      : null;

    if (!action) return;

    switch (action) {
      case 'CLOSE_MODAL':
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
        document.querySelectorAll('.popover').forEach(p => p.remove());
        break;

      case 'NAV_MONTH':
        switchView('month');
        break;

      case 'NAV_WEEK':
        switchView('week');
        break;

      case 'NAV_DAY':
        switchView('day');
        break;

      case 'NAV_AGENDA':
        switchView('agenda');
        break;

      case 'NAV_KANBAN':
        switchView('kanban');
        break;

      case 'NAV_TODAY':
        $('today-btn')?.click();
        break;

      case 'NAV_NEXT':
        $('next-btn')?.click();
        break;

      case 'NAV_PREV':
        $('prev-btn')?.click();
        break;

      case 'CREATE_EVENT':
        openCreateModal(store.get('currentDate') || new Date(), { onSaved: onEventSaved, onDeleted: onEventDeleted });
        break;

      case 'FOCUS_SEARCH':
        e.preventDefault();
        const searchInput = $('search-input');
        if (searchInput) searchInput.focus();
        break;

      case 'TOGGLE_HELP':
        const helpModal = $('shortcuts-modal-backdrop');
        if (helpModal) {
          if (helpModal.classList.contains('hidden')) {
            openDialog(helpModal);
          } else {
            closeDialog(helpModal);
          }
        }
        break;
    }
  });

  // Auto-refresh every 5 minutes
  setInterval(loadEvents, 5 * 60 * 1000);
}

// ── Toast Notifications ───────────────────────────────────────────────────────

export function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;

  if (type === 'error') {
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    setStatus('Fehler: ' + message);
  }

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escHtml(message)}</span>
    <span class="toast-close">×</span>`;

  container.appendChild(toast);
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());

  // Error toasts persist until closed; success/info toasts auto-dismiss after 4 seconds
  if (type !== 'error') {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function announce(msg) {
  if (!msg) return;
  const announcer = $('aria-announcer');
  if (announcer) {
    announcer.textContent = '';
    if (typeof setTimeout !== 'undefined') {
      setTimeout(() => {
        announcer.textContent = msg;
      }, 50);
    } else {
      announcer.textContent = msg;
    }
  }
  setStatus(msg);
}

function setStatus(msg) {
  const el = $('status-bar');
  if (el) el.textContent = msg;
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Welcome Modal ────────────────────────────────────────────────────────────

function initWelcomeModal() {
  const closeWelcome = () => {
    closeDialog($('welcome-modal-backdrop'));
    localStorage.setItem('welcome-popup-closed', 'true');
  };

  $('welcome-modal-close').addEventListener('click', closeWelcome);
  $('welcome-btn-close').addEventListener('click', closeWelcome);

  $('welcome-btn-add-account').addEventListener('click', () => {
    closeWelcome();
    openAccountModal({ onAdded: async () => {
      const accounts = await AccountsAPI.list();
      store.set({ accounts });
      showApp();
      await loadCalendars();
      await loadEvents();
      renderSidebar();
    }});
  });
}

function checkWelcomePopup(accounts) {
  const onlyInternal = accounts.length === 1 && accounts[0].id === 'internal-caldav';
  const hasClosed = localStorage.getItem('welcome-popup-closed') === 'true';
  
  if (onlyInternal && !hasClosed) {
    openDialog($('welcome-modal-backdrop'));
  }
}

export async function checkOAuthTokenStatus() {
  try {
    const res = await AccountsAPI.getOAuthTokenStatus();
    const accounts = res.accounts || [];
    const expiredAccounts = accounts.filter(a => a.expired);
    const banner = $('oauth-warning-banner');
    if (!banner) return;

    if (expiredAccounts.length > 0) {
      const textEl = $('oauth-warning-text');
      if (textEl) {
        if (expiredAccounts.length === 1) {
          textEl.textContent = `Google-Konto „${expiredAccounts[0].displayName || expiredAccounts[0].username}“ erfordert eine erneute Anmeldung.`;
        } else {
          textEl.textContent = `${expiredAccounts.length} Google-Konten erfordern eine erneute Anmeldung.`;
        }
      }
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (err) {
    console.warn('[OAuth status check error]', err);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot().catch(console.error);
