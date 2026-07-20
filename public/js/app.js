/**
 * app.js — FreeShard WebCalendar main orchestrator.
 * Entry point for all frontend logic.
 */

import { store, toggleCalendar, invalidateEventCache } from './store.js';
import { AccountsAPI, CalendarsAPI, EventsAPI } from './api.js';
import { renderView, getToolbarTitle, navigate, getDateRange, renderMiniCalendar } from './calendar.js';
import { initEventModal, openCreateModal, openEditModal, closeModal, chooseRecurrenceScope } from './eventModal.js';
import { initAccountModal, openAccountModal } from './accountModal.js';

// ── Element refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // Init modals first (attach event listeners)
  initEventModal();
  initAccountModal();
  initWelcomeModal();
  initIcsImport();

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
      checkWelcomePopup(accounts);
    }
  } catch (err) {
    console.error('Boot error:', err);
    showOnboarding();
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

async function loadEvents() {
  const view = store.get('view');
  const date = store.get('currentDate');
  const { start, end } = getDateRange(view, date);

  store.set({ loadingEvents: true });
  setStatus('Lade Termine…');

  try {
    const events = await EventsAPI.list(start.toISOString(), end.toISOString());
    // Merge into store (replace for current view range)
    store.set({ events });
    renderCalendarView();
    const count = events.length;
    setStatus(`${count} Termin${count !== 1 ? 'e' : ''} geladen.`);
    setTimeout(() => setStatus(''), 3000);
  } catch (err) {
    showToast('Fehler beim Laden der Termine: ' + err.message, 'error');
    setStatus('');
  } finally {
    store.set({ loadingEvents: false });
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderCalendarView() {
  const container  = $('calendar-container');
  const view       = store.get('view');
  const date       = store.get('currentDate');
  const events     = getFilteredEvents();

  // Toolbar title
  $('toolbar-title').textContent = getToolbarTitle(view, date);

  // Sync view tabs active state
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  renderView(container, events, view, date, {
    onDayClick:   (d) => openCreateModal(d, { onSaved: onEventSaved, onDeleted: onEventDeleted }),
    onEventClick: (uid, e) => {
      const ev = (store.get('events') || []).find(x => x.uid === uid);
      if (ev) showEventPopover(ev, e);
    }
  });

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

function renderSidebar() {
  renderCalendarList();
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
      <div class="calendar-item${checked ? ' checked' : ''}" data-cal-id="${c.id}">
        <div class="calendar-dot" style="background:${c.color}"></div>
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
        <div class="calendar-check" style="${checked ? 'background:' + c.color : ''}">
          <svg class="calendar-check-icon" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" width="10" height="10">
            <path d="M2 6l3 3 5-5"/>
          </svg>
        </div>
      </div>`;
  }).join('');

  // Toggle visibility on main area click
  list.querySelectorAll('[data-cal-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-edit-cal]') || e.target.closest('[data-share-cal]') || e.target.closest('[data-export-cal]')) return;
      toggleCalendar(el.dataset.calId);
      renderCalendarList();
      renderCalendarView();
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

  const sidebar = document.querySelector('.sidebar');

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

  // Click on the zone opens a file picker as a fallback to drag & drop
  zone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ics,text/calendar';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (file) openImportDialog(file.name, await file.text());
    });
    input.click();
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
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3 class="modal-title">ICS importieren</h3>
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
        <div style="display: flex; gap: 10px; margin-top: 18px;">
          <button type="button" class="btn btn-primary" id="import-confirm" style="flex: 1;">Importieren</button>
          <button type="button" class="btn btn-ghost" id="import-cancel" style="flex: 1;">Abbrechen</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#import-close').addEventListener('click', close);
  backdrop.querySelector('#import-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#import-confirm').addEventListener('click', async () => {
    const calId = backdrop.querySelector('#import-cal-select').value;
    const btn = backdrop.querySelector('#import-confirm');
    btn.disabled = true;
    btn.textContent = 'Importiere…';
    try {
      const result = await CalendarsAPI.importICS(calId, icsText);
      close();
      const parts = [`${result.imported} importiert`];
      if (result.skipped) parts.push(`${result.skipped} bereits vorhanden`);
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
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3 class="modal-title">Kalender bearbeiten</h3>
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
  const close = () => backdrop.remove();
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
      showToast(`Kalender umbenannt in „${name}".`, 'success');
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
        <h4 class="share-section-title">Mit anderen Benutzern teilen (CalDAV)</h4>
        <div style="background: rgba(234, 67, 53, 0.06); color: #d93025; padding: 12px 14px; border-radius: var(--radius-control); font-size: 0.8rem; line-height: 1.45; border: 1px solid rgba(234, 67, 53, 0.15); margin-top: 8px;">
          <strong>Teilen nicht möglich:</strong> Dieser Kalender wird über einen externen Server (${escHtml(serverHost)}) gehostet. Das direkte CalDAV-Teilen funktioniert nur mit Benutzern auf demselben CalDAV-Server. Nutze stattdessen unten die öffentliche Link-Freigabe.
        </div>
      </div>
    `;
  } else {
    caldavSharingHtml = `
      <!-- Section 1: CalDAV Sharing -->
      <div class="share-section" style="border-top:none;margin-top:0;padding-top:0;">
        <h4 class="share-section-title">Mit anderen Benutzern teilen (CalDAV)</h4>
        <p class="share-section-desc">Gib die E-Mail-Adresse oder den Namen eines Benutzers auf dem CalDAV-Server (${escHtml(serverHost)}) ein, um ihn einzuladen.</p>
        
        <div class="share-input-row">
          <div class="autocomplete-container">
            <input class="form-input" id="share-search-input" type="text" placeholder="Benutzer suchen oder E-Mail eingeben..." autocomplete="off" />
            <div class="autocomplete-dropdown hidden" id="share-autocomplete-dropdown"></div>
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
    <div class="modal" role="dialog" aria-modal="true" style="max-width:560px;">
      <div class="modal-header">
        <h3 class="modal-title">Freigabe & Sharing: ${escHtml(cal.name)}</h3>
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
  const close = () => backdrop.remove();
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
        showToast('Bitte wähle einen Benutzer oder eine E-Mail-Adresse.', 'warning');
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
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const q = searchInput.value.trim();
      if (q.length < 2) {
        autocompleteDropdown.classList.add('hidden');
        return;
      }

      searchTimeout = setTimeout(async () => {
        try {
          const users = await CalendarsAPI.searchUsers(q, cal.accountId);
          if (users.length === 0) {
            autocompleteDropdown.classList.add('hidden');
            return;
          }

          autocompleteDropdown.innerHTML = users.map(u => `
            <div class="autocomplete-item" data-value="${escHtml(u.href || u.email)}">
              <strong>${escHtml(u.displayname)}</strong> (${escHtml(u.email || u.href)})
            </div>
          `).join('');

          autocompleteDropdown.classList.remove('hidden');

          autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
              searchInput.value = item.dataset.value;
              autocompleteDropdown.classList.add('hidden');
            });
          });
        } catch (e) {
          console.error('User search failed:', e);
        }
      }, 300);
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.autocomplete-container')) {
        autocompleteDropdown.classList.add('hidden');
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
            if (!confirm(`Freigabe für „${href}“ entziehen?`)) return;
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

  async function loadPublicLink() {
    try {
      const data = await CalendarsAPI.getPublicLink(cal.id);
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
      console.error('Failed to load public link status:', e);
    }
  }

  publicEnable.addEventListener('change', async () => {
    try {
      if (publicEnable.checked) {
        const data = await CalendarsAPI.enablePublicLink(cal.id);
        publicArea.classList.remove('hidden');
        publicInput.value = data.url;
        showToast('Öffentlicher Link aktiviert.', 'success');
      } else {
        await CalendarsAPI.disablePublicLink(cal.id);
        publicArea.classList.add('hidden');
        publicInput.value = '';
        showToast('Öffentlicher Link deaktiviert.', 'info');
      }
    } catch (e) {
      showToast('Änderung fehlgeschlagen: ' + e.message, 'error');
      publicEnable.checked = !publicEnable.checked;
    }
  });

  publicCopy.addEventListener('click', () => {
    publicInput.select();
    navigator.clipboard.writeText(publicInput.value)
      .then(() => showToast('Link in Zwischenablage kopiert!', 'success'))
      .catch(() => showToast('Kopieren fehlgeschlagen.', 'error'));
  });

  publicRegen.addEventListener('click', async () => {
    if (!confirm('Bestehenden Link wirklich ungültig machen und neuen Link generieren?')) return;
    try {
      const data = await CalendarsAPI.enablePublicLink(cal.id);
      publicInput.value = data.url;
      showToast('Neuer Freigabe-Link generiert.', 'success');
    } catch (e) {
      showToast('Regenerierung fehlgeschlagen: ' + e.message, 'error');
    }
  });

  loadPublicLink();
}

function renderSettings() {
  renderSettingsAccounts();
  renderSettingsCalendars();
  renderSettingsAppPasswords();
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
        if (!confirm('Dieses App-Passwort wirklich löschen? Externe Clients mit diesem Passwort verlieren den Zugriff.')) return;
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
      if (!confirm(`Möchtest du den Account „${acc.displayName || acc.username}" wirklich entfernen? Alle zugehörigen Kalender werden ausgeblendet.`)) return;
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
            <div class="calendar-dot" style="background:${c.color}; width:8px; height:8px; border-radius:50%; flex-shrink:0"></div>
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
      if (!confirm(`Kalender „${cal.name}" und alle darin enthaltenen Termine unwiderruflich löschen?`)) return;
      try {
        await CalendarsAPI.remove(id);
        store.set({ calendars: store.get('calendars').filter(c => c.id !== id) });
        showToast(`Kalender „${cal.name}" gelöscht.`, 'info');
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
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h3 class="modal-title">Neuer Kalender</h3>
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
      showToast(`Kalender „${name}" erstellt.`, 'success');
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

  const actionsHtml = cal.readOnly
    ? `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Details</button>
       <span style="font-size:11px;color:var(--danger);margin-left:auto;padding-right:8px;font-weight:600;">Schreibgeschützt</span>`
    : `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Bearbeiten</button>
       <button class="btn btn-ghost btn-sm btn-danger" id="popover-delete-btn">Löschen</button>`;

  popover.innerHTML = `
    <div class="popover-color-bar" style="background:${color}"></div>
    <div class="popover-title">${escHtml(ev.title)}</div>
    <div class="popover-meta">
      <div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <span>${timeStr}</span>
      </div>
      ${ev.location ? `<div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        <span>${escHtml(ev.location)}</span>
      </div>` : ''}
      ${attHtml}
    </div>
    <div class="popover-actions">
      ${actionsHtml}
    </div>`;

  // Position near mouse
  popover.classList.remove('hidden');
  _popoverUid = ev.uid;

  const rect = popover.getBoundingClientRect();
  let top  = mouseEvent.clientY + 10;
  let left = mouseEvent.clientX + 10;
  if (top  + 200 > window.innerHeight) top  = mouseEvent.clientY - 220;
  if (left + 300 > window.innerWidth)  left = mouseEvent.clientX - 300;
  popover.style.top  = `${top}px`;
  popover.style.left = `${left}px`;

  $('popover-edit-btn').onclick = () => {
    closePopover();
    openEditModal(ev, { onSaved: onEventSaved, onDeleted: onEventDeleted });
  };
  $('popover-delete-btn').onclick = async () => {
    let scope = 'series';
    if (ev.recurrenceId) {
      scope = await chooseRecurrenceScope(`„${ev.title}" löschen:`);
      if (!scope) return;
    } else {
      if (!confirm(`„${ev.title}" löschen?`)) return;
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
  // View switcher
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.set({ view: btn.dataset.view });
      loadEvents();
    });
  });

  // Navigation
  $('prev-btn').addEventListener('click', () => {
    store.set({ currentDate: navigate(store.get('view'), store.get('currentDate'), -1) });
    loadEvents();
  });
  $('next-btn').addEventListener('click', () => {
    store.set({ currentDate: navigate(store.get('view'), store.get('currentDate'), 1) });
    loadEvents();
  });
  $('today-btn').addEventListener('click', () => {
    const t = new Date(); t.setHours(0,0,0,0);
    store.set({ currentDate: t });
    loadEvents();
  });

  // New event button
  $('new-event-btn').addEventListener('click', () => {
    openCreateModal(new Date(), { onSaved: onEventSaved, onDeleted: onEventDeleted });
  });

  // Settings Drawer Toggle
  $('sidebar-settings-btn').addEventListener('click', () => {
    $('settings-drawer').classList.add('open');
    renderSettings();
  });
  $('close-settings-btn').addEventListener('click', () => {
    $('settings-drawer').classList.remove('open');
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

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    switch (e.key) {
      case 'n': openCreateModal(new Date(), { onSaved: onEventSaved, onDeleted: onEventDeleted }); break;
      case 't': { const t = new Date(); t.setHours(0,0,0,0); store.set({ currentDate: t }); loadEvents(); break; }
      case 'ArrowLeft':  $('prev-btn').click(); break;
      case 'ArrowRight': $('next-btn').click(); break;
    }
  });

  // Auto-refresh every 5 minutes
  setInterval(loadEvents, 5 * 60 * 1000);
}

// ── Toast Notifications ───────────────────────────────────────────────────────

export function showToast(message, type = 'info') {
  const container = $('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escHtml(message)}</span>
    <span class="toast-close">×</span>`;

  container.appendChild(toast);
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg) {
  $('status-bar').textContent = msg;
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
    $('welcome-modal-backdrop').classList.add('hidden');
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
    $('welcome-modal-backdrop').classList.remove('hidden');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot().catch(console.error);
