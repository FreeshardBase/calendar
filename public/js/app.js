/**
 * app.js — FreeShard WebCalendar main orchestrator.
 * Entry point for all frontend logic.
 */

import { store, toggleCalendar, invalidateEventCache, cacheEvents, getCachedEvents, setCalendarSyncCache, getCalendarSyncCache } from './store.js';
import { AccountsAPI, CalendarsAPI, EventsAPI, TasksAPI, WebcalAPI, HolidaysAPI, PreferencesAPI, TrashAPI, setUnauthorizedHandler } from './api.js';
import { enableReorder, applyGroupOrder, renderLater } from './sidebarOrder.js';
import { calendarLabel, groupCalendarsByAccount, fillCalendarSelect, holdsEvents, holdsTasks, collectionNoun, collectionTypeLabel, formerLinkLabel } from './calendarLabels.js';
import { renderView, getToolbarTitle, navigate, getDateRange, renderMiniCalendar, sanitizeColor } from './calendar.js';
import { searchTimeZones, zoneOffsetLabel, localTimeZone } from './timezones.js';
import { initEventModal, openCreateModal, openEditModal, openDuplicateModal, closeModal, chooseRecurrenceScope } from './eventModal.js';
import { openContextMenu } from './contextMenu.js';
import { initAccountModal, openAccountModal } from './accountModal.js';
import { initNotificationService, checkAndTriggerAlarms, requestNotificationPermission } from './notifications.js';
import { initTaskUI, openTaskModal, openDuplicateTaskModal, renderTaskArea, renderSidebarTasks } from './tasks.js';
import { initInvitations } from './invitations.js';
import { initListView, loadListPage, renderListView } from './listView.js';
import { initPdfExport } from './pdfExport.js';
import { initAvailabilityManager } from './availability.js';
import { initMSGraphModal, openMSGraphModal } from './msgraph.js';
import { initDialogFocusManager, openDialog, closeDialog, confirmDialog, typedConfirmDialog, handleEscapeKey } from './dialogFocus.js';

const { initTheme, setTheme, getStoredTheme } = (typeof window !== 'undefined' && window.ThemeManager) ? window.ThemeManager : {};
const { isSafeLinkUrl } = window.SafeUrl;

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

const ACCOUNTS_LOAD_ERROR = 'Fehler beim Laden der Kontodaten';

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
  initTaskUI({ onTaskChanged: reloadTasksAfterEdit });
  initItemContextMenu();
  initInvitations();
  initListView({
    showToast,
    onEventClick: (ev, e) => showEventPopover(ev, e),
    onChanged: () => { invalidateEventCache(); loadEvents(); },
  });
  initAvailabilityManager();
  initMSGraphModal();
  initDialogFocusManager();
  initWebcalUI();

  if (typeof window !== 'undefined' && window.OfflineCache) {
    window.OfflineCache.registerServiceWorker();
    window.OfflineCache.initOfflineListeners();
  }


  // Attach UI event listeners
  attachListeners();
  setUnauthorizedHandler(showReauth);

  try {
    const accounts = await AccountsAPI.list();
    store.set({ accounts });

    if (accounts.length === 0) {
      showOnboarding();
    } else {
      hideLoading();
      showApp();
      // Preferences first: the first render of the grid already needs the second time zone.
      const prefs = await PreferencesAPI.get();
      store.set({
        taskView: prefs.taskView,
        secondaryTimezone: prefs.secondaryTimezone,
        tasksHiddenInCalendar: new Set(prefs.tasksHiddenInCalendar),
      });
      // #614: msgraph.js reports a Microsoft 365 account disconnected.
      window.addEventListener('linked-accounts-changed', async () => {
        await loadCalendars();
        renderSidebar();
      });
      await loadCalendars();
      await offerReattach();
      holidayRegion = (await HolidaysAPI.getSettings()).region;
      await loadWebcalSubscriptions();
      await loadEvents();
      await loadTasks();
      await checkOAuthTokenStatus();
      await checkSyncStatus();
      setInterval(checkSyncStatus, 60 * 1000);
      checkWelcomePopup(accounts);
    }
  } catch (err) {
    console.error('Boot error:', err);
    // #224: a 401 already shows the sign-in prompt; any other failure keeps the app shell and says so.
    if (err.status === 401) return;
    store.set({ calendarsError: err.message });
    hideLoading();
    showApp();
    // The server's own message for this request already names it; only add context to anything else.
    const message = err.message.startsWith(ACCOUNTS_LOAD_ERROR) ? err.message : `${ACCOUNTS_LOAD_ERROR}: ${err.message}`;
    showToast(message, 'error');
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

function showReauth() {
  hideLoading();
  $('onboarding').classList.add('hidden');
  $('app').classList.add('hidden');
  $('reauth-screen').classList.remove('hidden');
}

function showApp() {
  $('onboarding').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderSidebar();
  renderCalendarView();
  announce('Kalender geladen');
}

// ── Data loading ──────────────────────────────────────────────────────────────

// #593: local edits per collection. A list fetched while the user changed it may have been
// answered before the change landed on the server, so it is fetched again rather than shown.
const localEdits = { calendars: 0, tasks: 0 };
function noteLocalEdit(collection) {
  localEdits[collection]++;
}
async function listAfterLocalEdits(collection, fetchList) {
  for (;;) {
    const edits = localEdits[collection];
    const res = await fetchList();
    if (edits === localEdits[collection]) return res;
  }
}

// #614: an account linked again can take back the calendars kept when it was disconnected.
async function offerReattach() {
  const offers = await AccountsAPI.getReattachOffers();
  if (!offers.length) return;
  const names = offers.map(o => {
    const cal = store.get('calendars').find(c => c.id === o.calendarId);
    return `„${cal ? cal.name : o.calendarId}“`;
  }).join(', ');
  const accept = await confirmDialog(
    `Dieses Konto war schon einmal verknüpft. Sollen die behaltenen Kalender ${names} wieder damit verbunden werden? ` +
    'Die Synchronisation läuft dann in ihnen weiter, ohne Termine zu verdoppeln. Sonst bleiben sie eigene Kalender, und das Konto bekommt neue.',
    'Kalender wieder verbinden'
  );
  await AccountsAPI.resolveReattachOffers(accept);
  showToast(accept ? 'Kalender wieder verbunden.' : 'Kalender bleiben eigene Kalender.', 'info');
  await loadCalendars();
}

async function loadCalendars() {
  store.set({ loadingCalendars: true });
  try {
    const res = await listAfterLocalEdits('calendars', () => listAfterOrderSaves(() => CalendarsAPI.list()));
    store.set({
      calendars: res.calendars || [],
      accountErrors: res.errors || [],
      calendarsError: null
    });
    if (res.errors?.length) {
      res.errors.forEach(e => console.warn('[calendar load error]', e));
    }
  } catch (err) {
    store.set({ calendarsError: err.message });
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

// Asks every calendar for its changes since the last sync token (RFC 6578).
// True only if each calendar had a token and reports no change; an empty
// calendar list, a calendar without a token, a response without a new token,
// a fallback to an initial sync or a failed check count as changed. Either way
// the tokens are advanced before the caller fetches, so a change landing after
// this check is seen by the next one (#170).
async function calendarsUnchanged() {
  const calendars = store.get('calendars') || [];
  if (calendars.length === 0) return false;
  const results = await Promise.all(calendars.map(async (cal) => {
    const hadToken = Boolean(getCalendarSyncCache(cal.id)?.syncToken);
    const res = await syncCalendarDelta(cal.id);
    return hadToken && Boolean(res?.syncToken) && !res.fallbackPerformed &&
      (res.updated || []).length === 0 && (res.deleted || []).length === 0 &&
      (res.unparseable || []).length === 0;
  }));
  return results.every(Boolean);
}

let loadEventsSeq = 0;
let lastUnparseableNotice = '';

// Events the server could not parse are missing from the view — say so once
// per distinct set instead of on every reload (#128).
function reportUnparseableEvents(info) {
  const key = JSON.stringify(info);
  if (key === lastUnparseableNotice) return;
  lastUnparseableNotice = key;
  const n = info.count;
  showToast(n === 1
    ? '1 gespeicherter Termin konnte nicht gelesen werden und wird nicht angezeigt.'
    : `${n} gespeicherte Termine konnten nicht gelesen werden und werden nicht angezeigt.`, 'error');
  console.error('[loadEvents] Unparseable CalDAV resources:', info.resources);
}

let lastEventErrorNotice = '';

// Calendars the server could not read are missing from the view, which must
// not look like a free week (#65): badge them in the sidebar and say so once
// per distinct set of failures.
function reportEventLoadErrors(errors) {
  store.set({ eventErrors: errors });
  renderCalendarList();
  const key = JSON.stringify(errors);
  if (key === lastEventErrorNotice) return;
  lastEventErrorNotice = key;
  if (errors.length === 0) return;
  const failed = (store.get('calendars') || []).filter(c => calendarLoadError(c));
  const names = failed.length > 0 ? failed.map(calendarLabel).join(', ') : errors.map(e => e.accountId).join(', ');
  showToast(`Termine konnten nicht vollständig geladen werden (${names}): ${errors[0].error}`, 'error');
  console.error('[loadEvents] CalDAV fetch errors:', errors);
}

// The /api/events error for this calendar: its own, or its account's when the
// whole account could not be read.
function calendarLoadError(cal) {
  return (store.get('eventErrors') || []).find(e =>
    e.calendarId ? e.calendarId === cal.id : e.accountId === cal.accountId);
}

async function loadEvents() {
  const seq = ++loadEventsSeq;
  const view = store.get('view');
  // #510: the list loads its own range page by page.
  if (view === 'list') {
    renderCalendarView();
    return loadListPage();
  }
  const date = store.get('currentDate');
  const { start, end } = getDateRange(view, date);
  const cacheKey = `${view}_${start.toISOString()}_${end.toISOString()}`;

  let cached = getCachedEvents(cacheKey);
  const activeSubs = webcalEvents.filter(ev => !hiddenWebcal.has(ev.subscriptionId));
  if (cached && Array.isArray(cached)) {
    showEvents([...cached, ...activeSubs]);
    renderCalendarView();
  } else {
    store.set({ loadingEvents: true });
    announce('Lade Termine…');
  }

  try {
    const webcalPromise = loadWebcalEvents(start, end);
    // Cheap delta check first: if no calendar changed, the cached range is
    // still exact and the full PROPFIND + REPORT + re-expansion is skipped.
    const unchanged = await calendarsUnchanged();
    if (!unchanged) invalidateEventCache();
    // Re-read: a concurrent load may have dropped the cache meanwhile.
    cached = getCachedEvents(cacheKey);
    if (unchanged && cached) {
      const rangeWebcalEvents = await webcalPromise;
      if (seq !== loadEventsSeq) return;
      webcalEvents = rangeWebcalEvents;
      const activeCurrentSubs = webcalEvents.filter(ev => !hiddenWebcal.has(ev.subscriptionId));
      showEvents([...cached, ...activeCurrentSubs]);
      renderCalendarView();
      checkAndTriggerAlarms();
      return;
    }
    let unparseable = null;
    const { events, errors } = await EventsAPI.list(start.toISOString(), end.toISOString(), info => { unparseable = info; });
    const rangeWebcalEvents = await webcalPromise;
    if (seq !== loadEventsSeq) return;
    if (unparseable) reportUnparseableEvents(unparseable);
    reportEventLoadErrors(errors);
    webcalEvents = rangeWebcalEvents;
    // Events from a calendar the delta check does not know (created or shared
    // elsewhere): other cached ranges may lack it, and it needs a sync token.
    const known = new Set((store.get('calendars') || []).map(c => c.id));
    if (events.some(ev => !known.has(ev.calendarId))) {
      invalidateEventCache();
      loadCalendars().catch(err => {
        console.error('[loadEvents] Calendar reload failed:', err);
        showToast('Kalender konnten nicht geladen werden: ' + err.message, 'error');
      });
    }
    // A partial result is not cached: the next load must ask the failed calendars again.
    if (errors.length === 0) cacheEvents(cacheKey, events);
    const activeCurrentSubs = webcalEvents.filter(ev => !hiddenWebcal.has(ev.subscriptionId));
    showEvents([...events, ...activeCurrentSubs]);
    store.set({ eventsError: null });
    renderCalendarView();
    checkAndTriggerAlarms();
  } catch (err) {
    if (seq !== loadEventsSeq) return;
    // With nothing cached the view is empty because of the failure, not because
    // the range is free; the status bar must say so and keep saying it (#106).
    store.set({ eventsError: cached ? null : err.message });
    renderCalendarView();
    if (!cached) {
      showToast('Fehler beim Laden der Termine: ' + err.message, 'error');
    }
  } finally {
    if (seq === loadEventsSeq) {
      store.set({ loadingEvents: false });
    }
  }
}

let lastUnparseableTaskNotice = '';

// Tasks the server could not parse are missing from the list — say so once
// per distinct set instead of on every reload (#208).
function reportUnparseableTasks(info) {
  const key = JSON.stringify(info);
  if (key === lastUnparseableTaskNotice) return;
  lastUnparseableTaskNotice = key;
  const n = info.count;
  showToast(n === 1
    ? '1 gespeicherte Aufgabe konnte nicht gelesen werden und wird nicht angezeigt.'
    : `${n} gespeicherte Aufgaben konnten nicht gelesen werden und werden nicht angezeigt.`, 'error');
  console.error('[loadTasks] Unparseable CalDAV resources:', info.resources);
}

async function loadTasks() {
  store.set({ loadingTasks: true });
  try {
    const tasks = await listAfterLocalEdits('tasks', () => TasksAPI.list(reportUnparseableTasks));
    store.set({ tasks, tasksError: null });
    renderTaskSidebar();
    // The grid views show tasks by their due date (#577); the event status in the bar stays as it is.
    const view = store.get('view');
    if (view === 'kanban') renderCalendarView();
    else if (TASK_VIEWS.has(view)) renderCalendarView({ announceStatus: false });
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

const TASK_VIEWS = new Set(['month', 'week', 'workweek', 'day']);

// A task was changed on the server: a task list still being fetched may predate it (#593).
function reloadTasksAfterEdit() {
  noteLocalEdit('tasks');
  return loadTasks();
}

// ── Webcal Subscriptions State & Logic ────────────────────────────────────────
let webcalSubscriptions = [];
let webcalEvents = [];
let lastWebcalEventsFailure = '';
const hiddenWebcal = new Set();
// #514: the built-in holiday subscription; its events travel with the webcal events.
const HOLIDAY_SUB_ID = 'holidays';
const HOLIDAY_COLOR = '#16a34a';
let holidayRegion = null;
let holidayName = '';

async function loadWebcalSubscriptions() {
  try {
    const res = await listAfterOrderSaves(() => WebcalAPI.list());
    webcalSubscriptions = res.subscriptions || [];
    renderWebcalSidebar();
    renderHolidaySidebar();

    const { start, end } = getDateRange(store.get('view'), store.get('currentDate'));
    webcalEvents = await loadWebcalEvents(start, end);
    mergeAndRenderEvents();
  } catch (err) {
    console.error('[webcal] Failed to load subscriptions:', err);
    showToast('Abonnements konnten nicht geladen werden: ' + err.message, 'error');
  }
}

// #342: the server expands recurring feed events for the visible range.
async function loadWebcalEvents(start, end) {
  const allEvents = [];
  const failed = [];
  await Promise.all(
    webcalSubscriptions.map(async (sub) => {
      try {
        const evRes = await WebcalAPI.getEvents(sub.id, start.toISOString(), end.toISOString());
        const evs = (evRes.events || []).map(e => ({
          ...e,
          isSubscription: true,
          subscriptionId: sub.id,
          subscriptionName: sub.name,
          calendarId: `webcal::${sub.id}`,
          color: sub.color || e.color || '#3b82f6',
          readOnly: true
        }));
        allEvents.push(...evs);
      } catch (e) {
        console.error('[webcal] Failed to load events for subscription:', sub.id, e);
        failed.push(`${sub.name}: ${e.message}`);
      }
    }),
    loadHolidayEvents(start, end).then(evs => allEvents.push(...evs), e => {
      console.error('[holidays] Failed to load holidays:', e);
      failed.push(`Feiertage: ${e.message}`);
    })
  );
  // Every navigation reloads the range; the same failure is reported once, not once per page turn.
  const failure = failed.length > 0
    ? 'Termine aus Abonnements konnten nicht geladen werden (' + failed.sort().join('; ') + ')'
    : '';
  if (failure && failure !== lastWebcalEventsFailure) {
    showToast(failure, 'error');
  }
  lastWebcalEventsFailure = failure;
  return allEvents;
}

async function loadHolidayEvents(start, end) {
  const region = holidayRegion;
  if (!region) return [];
  const res = await HolidaysAPI.getEvents(start.toISOString(), end.toISOString());
  // A region switched meanwhile: these belong to the old one.
  if (region !== holidayRegion) return [];
  if (res.name !== holidayName) {
    holidayName = res.name;
    renderHolidaySidebar();
  }
  return res.events.map(e => ({
    ...e,
    isSubscription: true,
    isHoliday: true,
    // The all-day date the week/day views shade as non-working (#19).
    holidayDate: e.start,
    subscriptionId: HOLIDAY_SUB_ID,
    subscriptionName: res.name,
    calendarId: `webcal::${HOLIDAY_SUB_ID}`,
    color: HOLIDAY_COLOR,
    readOnly: true
  }));
}

function renderHolidaySidebar() {
  const list = $('holiday-list');
  if (!list) return;
  if (!holidayRegion) {
    list.innerHTML = '';
    return;
  }
  const checked = !hiddenWebcal.has(HOLIDAY_SUB_ID);
  const name = holidayName || 'Feiertage';
  list.innerHTML = `
    <div class="calendar-item${checked ? ' checked' : ''}" data-holiday-item tabindex="0" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${escHtml(name)}">
      <div class="calendar-dot" style="background:${HOLIDAY_COLOR}"></div>
      <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; justify-content: center; line-height: 1.2;">
        <span class="calendar-name" style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(name)}">${escHtml(name)}</span>
        <span style="font-size: 0.65rem; color: var(--ink-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">Gesetzliche Feiertage</span>
      </div>
      <div class="calendar-check" style="${checked ? 'background:' + HOLIDAY_COLOR : ''}">
        <svg class="calendar-check-icon" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" width="10" height="10" aria-hidden="true">
          <path d="M2 6l3 3 5-5"/>
        </svg>
      </div>
    </div>`;
  const item = list.querySelector('[data-holiday-item]');
  const toggle = () => {
    if (hiddenWebcal.has(HOLIDAY_SUB_ID)) hiddenWebcal.delete(HOLIDAY_SUB_ID);
    else hiddenWebcal.add(HOLIDAY_SUB_ID);
    renderHolidaySidebar();
    list.querySelector('[data-holiday-item]').focus();
    mergeAndRenderEvents();
  };
  item.addEventListener('click', toggle);
  item.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

let holidayCountries = null;

async function renderSettingsHolidays() {
  if (!holidayCountries) holidayCountries = (await HolidaysAPI.regions()).countries;
  const countrySelect = $('holiday-country');
  const regionSelect = $('holiday-region');
  const countryCode = holidayRegion ? holidayRegion.split('-')[0] : '';
  countrySelect.innerHTML = '<option value="">Keine Feiertage anzeigen</option>' + holidayCountries
    .map(c => `<option value="${escHtml(c.code)}">${escHtml(c.name)}</option>`).join('');
  countrySelect.value = countryCode;
  const country = holidayCountries.find(c => c.code === countryCode);
  $('holiday-region-group').classList.toggle('hidden', !country);
  regionSelect.innerHTML = country
    ? '<option value="" disabled>Region wählen</option>' + country.regions
      .map(r => `<option value="${escHtml(r.code)}">${escHtml(r.name)}</option>`).join('')
    : '';
  regionSelect.value = holidayRegion || '';
}

async function changeHolidayRegion(region) {
  holidayRegion = (await HolidaysAPI.setRegion(region)).region;
  holidayName = '';
  hiddenWebcal.delete(HOLIDAY_SUB_ID);
  renderHolidaySidebar();
  const { start, end } = getDateRange(store.get('view'), store.get('currentDate'));
  const holidays = await loadHolidayEvents(start, end);
  webcalEvents = [...webcalEvents.filter(ev => !ev.isHoliday), ...holidays];
  mergeAndRenderEvents();
  announce(holidayRegion ? `Feiertage: ${holidayName}` : 'Feiertage ausgeblendet');
}

function mergeAndRenderEvents() {
  const normalEvents = loadedEvents.filter(e => !e.isSubscription);
  const activeWebcal = webcalEvents.filter(ev => !hiddenWebcal.has(ev.subscriptionId));
  showEvents([...normalEvents, ...activeWebcal]);
  renderCalendarView();
}

// ── Optimistic event saves (Issue #174) ──────────────────────────────────────
// A saved event is shown at once while its request runs. The pending previews
// overlay whatever loadEvents() brings, so a reload meanwhile does not hide
// them; on failure the preview is dropped and the loaded state shows again.

// token → { preview, replacesUid, resolve }; resolve() settles the save with the
// uid of the stored event once it is loaded, or null if the save failed.
const pendingSaves = new Map();
// preview uid → its `settled` promise; kept until the reload after the save is done.
const pendingClicks = new Map();
let loadedEvents = [];

function withPendingSaves(events) {
  if (pendingSaves.size === 0) return events;
  const saves = [...pendingSaves.values()];
  const replaced = new Set(saves.map(s => s.replacesUid).filter(Boolean));
  return [...events.filter(ev => !replaced.has(ev.uid)), ...saves.map(s => s.preview)];
}

function showEvents(events) {
  loadedEvents = events;
  store.set({ events: withPendingSaves(events) });
}

function onEventPending(preview, replacesUid) {
  const token = Symbol('pending-save');
  let resolve;
  const settled = new Promise(r => { resolve = r; });
  pendingSaves.set(token, { preview: { ...preview, pending: true }, replacesUid, resolve });
  pendingClicks.set(preview.uid, settled);
  settled.then(() => pendingClicks.delete(preview.uid));
  showEvents(loadedEvents);
  renderCalendarView();
  return token;
}

// The save failed: the preview goes, the loaded state shows again.
function settlePendingSave(token) {
  const entry = pendingSaves.get(token);
  pendingSaves.delete(token);
  showEvents(loadedEvents);
  renderCalendarView();
  entry?.resolve(null);
}

// A click on a pending event opens the popover of the stored event once the
// save has landed; after a failure the error toast has already said why not.
async function openPendingEvent(preview, mouseEvent) {
  const settled = pendingClicks.get(preview.uid);
  const uid = settled ? await settled : null;
  if (!uid) return;
  const ev = (store.get('events') || []).find(x => x.uid === uid || x.uid.startsWith(`${uid}::`));
  if (ev) showEventPopover(ev, mouseEvent);
}

// #504: a sidebar list re-renders when it is reordered or reloaded; keyboard focus stays on the
// entry that had it (by its data-* id), not on the page body.
function focusedItemId(list, key) {
  const el = document.activeElement;
  return el && list.contains(el) && el.dataset[key] ? el.dataset[key] : null;
}

function refocusItem(list, key, id) {
  if (id === null) return;
  const el = [...list.children].find(x => x.dataset[key] === id);
  if (el) el.focus();
}

function renderWebcalSidebar() {
  const list = $('webcal-list');
  if (!list) return;
  if (renderLater(list, renderWebcalSidebar)) return;

  if (!webcalSubscriptions.length) {
    list.innerHTML = '<div style="font-size:0.78rem;color:var(--ink-muted);padding:4px 8px">Keine Abonnements vorhanden.</div>';
    return;
  }

  const focusedId = focusedItemId(list, 'webcalId');
  list.innerHTML = webcalSubscriptions.map(sub => {
    const checked = !hiddenWebcal.has(sub.id);
    return `
      <div class="calendar-item${checked ? ' checked' : ''}" data-webcal-id="${escHtml(sub.id)}" data-order-group="webcal" tabindex="0" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${escHtml(sub.last_error ? `${sub.name} (Sync fehlgeschlagen: ${sub.last_error})` : sub.name)}">
        <div class="calendar-dot" style="background:${escHtml(sanitizeColor(sub.color))}"></div>
        <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; justify-content: center; line-height: 1.2;">
          <span class="calendar-name" style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(sub.name)}">${escHtml(sub.name)}</span>
          ${sub.last_error
            ? `<span class="webcal-sync-error" style="font-size: 0.65rem; color: var(--danger); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(sub.last_error)}">Sync fehlgeschlagen – zeige letzten Stand</span>`
            : '<span style="font-size: 0.65rem; color: var(--ink-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">Webcal-Feed</span>'}
        </div>
        <div class="cal-item-actions">
          <button class="cal-action-btn" data-sync-webcal="${escHtml(sub.id)}" title="Jetzt synchronisieren" aria-label="Jetzt synchronisieren">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
          <button class="cal-action-btn" data-delete-webcal="${escHtml(sub.id)}" title="Abonnement löschen" aria-label="Abonnement löschen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
        <div class="calendar-check" style="${checked ? 'background:' + escHtml(sanitizeColor(sub.color)) : ''}">
          <svg class="calendar-check-icon" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" width="10" height="10" aria-hidden="true">
            <path d="M2 6l3 3 5-5"/>
          </svg>
        </div>
      </div>`;
  }).join('');
  refocusItem(list, 'webcalId', focusedId);

  // #504: subscriptions are their own group; their order is stored as `webcal::<id>`.
  enableReorder(list, {
    itemSelector: '[data-webcal-id]',
    idOf: el => el.dataset.webcalId,
    onReorder: ids => {
      webcalSubscriptions = applyGroupOrder(webcalSubscriptions, ids, sub => sub.id);
      renderWebcalSidebar();
      saveSidebarOrder(ids.map(id => `webcal::${id}`), loadWebcalSubscriptions);
    },
  });

  list.querySelectorAll('[data-webcal-id]').forEach(el => {
    const handleToggle = e => {
      if (e.target.closest('[data-sync-webcal]') || e.target.closest('[data-delete-webcal]')) return;
      const id = el.dataset.webcalId;
      if (hiddenWebcal.has(id)) {
        hiddenWebcal.delete(id);
      } else {
        hiddenWebcal.add(id);
      }
      renderWebcalSidebar();
      mergeAndRenderEvents();
    };

    el.addEventListener('click', handleToggle);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('[data-sync-webcal]') || e.target.closest('[data-delete-webcal]')) return;
        e.preventDefault();
        handleToggle(e);
      }
    });
  });

  list.querySelectorAll('[data-sync-webcal]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.syncWebcal;
      try {
        btn.classList.add('rotating');
        const res = await WebcalAPI.sync(id);
        showToast(`Abonnement synchronisiert (${res.eventCount || 0} Termine).`, 'success');
        await loadWebcalSubscriptions();
      } catch (err) {
        showToast('Sync fehlgeschlagen: ' + err.message, 'error');
        await loadWebcalSubscriptions();
      } finally {
        btn.classList.remove('rotating');
      }
    });
  });

  list.querySelectorAll('[data-delete-webcal]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.deleteWebcal;
      const sub = webcalSubscriptions.find(s => s.id === id);
      if (!sub) return;
      if (!(await confirmDialog(`Abonnement „${sub.name}“ wirklich löschen?`))) return;
      try {
        await WebcalAPI.remove(id);
        showToast(`Abonnement „${sub.name}“ gelöscht.`, 'info');
        webcalSubscriptions = webcalSubscriptions.filter(s => s.id !== id);
        webcalEvents = webcalEvents.filter(ev => ev.subscriptionId !== id);
        renderWebcalSidebar();
        mergeAndRenderEvents();
      } catch (err) {
        showToast('Fehler beim Löschen: ' + err.message, 'error');
      }
    });
  });
}

function openAddWebcalDialog() {
  const backdrop = $('webcal-modal-backdrop');
  if (!backdrop) return;
  const formEl = $('webcal-form');
  if (formEl) formEl.reset();
  const errEl = $('webcal-form-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  openDialog(backdrop);
}

function initWebcalUI() {
  const addBtn = $('add-webcal-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => openAddWebcalDialog());
  }

  const backdrop = $('webcal-modal-backdrop');
  const closeBtn = $('webcal-modal-close');
  const cancelBtn = $('webcal-cancel-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => closeDialog(backdrop));
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeDialog(backdrop));

  const formEl = $('webcal-form');
  if (formEl) {
    formEl.addEventListener('submit', async e => {
      e.preventDefault();
      const url = $('webcal-url').value.trim();
      const name = $('webcal-name').value.trim();
      const color = $('webcal-color').value;
      const refreshInterval = parseInt($('webcal-refresh').value, 10) || 3600;
      const errEl = $('webcal-form-error');

      if (!url || !name) {
        if (errEl) {
          errEl.textContent = 'Bitte URL und Bezeichnung angeben.';
          errEl.classList.remove('hidden');
        }
        return;
      }

      const saveBtn = $('webcal-save-btn');
      const label = saveBtn?.querySelector('.btn-label');
      const spinner = saveBtn?.querySelector('.btn-spinner');
      if (label) label.classList.add('hidden');
      if (spinner) spinner.classList.remove('hidden');
      if (saveBtn) saveBtn.disabled = true;

      try {
        await WebcalAPI.create({ name, url, color, refreshInterval });
        closeDialog(backdrop);
        showToast(`Abonnement „${name}“ erfolgreich hinzugefügt.`, 'success');
        await loadWebcalSubscriptions();
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Fehler beim Abonnieren des Feeds';
          errEl.classList.remove('hidden');
        } else {
          showToast(err.message, 'error');
        }
      } finally {
        if (label) label.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
        if (saveBtn) saveBtn.disabled = false;
      }
    });
  }
}

function renderTaskSidebar() {
  const container = $('sidebar-task-list');
  const countBadge = $('sidebar-task-count');
  const tasks = store.get('tasks') || [];
  const tasksError = store.get('tasksError');
  renderSidebarTasks(container, countBadge, tasks, { onTaskChanged: reloadTasksAfterEdit }, { error: tasksError });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const EMPTY_RANGE_TEXT = {
  month:    'Keine Termine in diesem Monat.',
  week:     'Keine Termine in dieser Woche.',
  workweek: 'Keine Termine in dieser Arbeitswoche.',
  day:      'Keine Termine an diesem Tag.',
  agenda:   'Keine Termine im gewählten Zeitraum.'
};

// The status bar must say which state the view is in — failed, partial, free
// or a count — never a bare "0" that reads like a failed load (#106).
function eventStatusText(view, count, query) {
  const eventsError = store.get('eventsError');
  if (eventsError) return `Fehler beim Laden der Termine: ${eventsError}`;
  if (query) return `${count} Ergebnis${count !== 1 ? 'se' : ''} für „${query}“`;
  const partial = (store.get('eventErrors') || []).length > 0;
  if (count === 0) {
    if (partial) return 'Keine Termine geladen – nicht alle Kalender konnten gelesen werden.';
    if (!EMPTY_RANGE_TEXT[view]) throw new Error(`No empty-state text for view "${view}"`);
    return EMPTY_RANGE_TEXT[view];
  }
  const text = `${count} Termin${count !== 1 ? 'e' : ''}`;
  return partial ? `${text} – nicht alle Kalender konnten gelesen werden.` : text;
}

function syncViewTabs(view) {
  document.querySelectorAll('.view-tab').forEach(btn => {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function renderCalendarView({ announceStatus = true } = {}) {
  const container  = $('calendar-container');
  const view       = store.get('view');
  const date       = store.get('currentDate');
  const events     = getFilteredEvents();
  const searchQuery = store.get('searchQuery');

  if (view === 'kanban') {
    $('toolbar-title').textContent = 'Aufgaben';
    document.querySelectorAll('.view-tab').forEach(btn => {
      const isActive = btn.dataset.view === 'kanban';
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const tasks = getFilteredTasks();
    const tasksError = store.get('tasksError');
    renderTaskArea(container, tasks, { onTaskChanged: reloadTasksAfterEdit }, {
      searchQuery, error: tasksError, taskView: store.get('taskView'), onTaskViewChange: changeTaskView
    });
    const count = tasks.length;
    if (tasksError) {
      announce('Fehler beim Laden der Aufgaben');
    } else if (searchQuery && searchQuery.trim() && count === 0) {
      announce(`0 Ergebnisse für „${searchQuery.trim()}“`);
    } else if (count === 0) {
      announce('Keine Aufgaben vorhanden.');
    } else {
      announce(`${count} Aufgabe${count !== 1 ? 'n' : ''}`);
    }
    return;
  }

  // Toolbar title
  $('toolbar-title').textContent = getToolbarTitle(view, date);

  if (view === 'list') {
    syncViewTabs(view);
    renderListView(container);
    return;
  }

  syncViewTabs(view);

  // Open tasks with a due date show in the grid views by that date (#577).
  const shown = view === 'agenda' ? events : events.concat(calendarTaskItems());
  renderView(container, shown, view, date, {
    onDayClick:   (d) => openCreateModal(d, EVENT_MODAL_CALLBACKS),
    onEventClick: (uid, e) => {
      if (uid.startsWith(TASK_ITEM_PREFIX)) {
        const task = (store.get('tasks') || []).find(t => TASK_ITEM_PREFIX + t.uid === uid);
        if (task && !task.pending) openTaskModal(task);
        return;
      }
      const ev = (store.get('events') || []).find(x => x.uid === uid);
      if (ev?.pending) openPendingEvent(ev, e);
      else if (ev) showEventPopover(ev, e);
    },
    canDrag: eventDragPermission,
    onEventDrop,
    onCreateRange: range => openCreateModal(null, EVENT_MODAL_CALLBACKS, range),
    readOnlyNotice: message => showToast(message, 'warning'),
    announce
  });

  const query = searchQuery ? searchQuery.trim() : '';
  if (query && events.length === 0 && !store.get('eventsError')) {
    const banner = document.createElement('div');
    banner.className = 'search-empty-banner';
    banner.innerHTML = `<span class="search-empty-icon">🔍</span> Keine Termine für „${escapeHtml(query)}“ gefunden.`;
    container.insertBefore(banner, container.firstChild);
  }
  if (announceStatus) announce(eventStatusText(view, events.length, query));

  // Mini calendar
  renderMiniCalendar(
    $('mini-calendar'),
    date,
    store.get('events') || [],
    (d) => {
      store.set({ currentDate: d });
      loadEvents();
      announce(`Datum: ${d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
    }
  );
}

// #498: "Liste | Kanban" is remembered per user on the server.
async function changeTaskView(taskView) {
  store.set({ taskView });
  renderCalendarView();
  announce(taskView === 'list' ? 'Aufgaben als Liste' : 'Aufgaben als Kanban-Board');
  try {
    await PreferencesAPI.setTaskView(taskView);
  } catch (err) {
    showToast('Die Ansicht konnte nicht gespeichert werden: ' + err.message, 'error');
  }
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
  const hidden = store.get('hiddenCalendars');
  const tasks = (store.get('tasks') || []).filter(t => !hidden.has(t.calendarId));
  const query = store.get('searchQuery').toLowerCase();
  if (!query) return tasks;
  return tasks.filter(t =>
    (t.title || '').toLowerCase().includes(query) ||
    (t.description || '').toLowerCase().includes(query)
  );
}

function renderSidebar() {
  renderCalendarList();
  renderWebcalSidebar();
  renderTaskSidebar();
  renderSettings();
}

const CALENDARS_LOAD_FAILED = 'Kalender konnten nicht geladen werden.';

function calendarListItemHtml(c, hidden, orderGroup, taskView) {
  const checked = !hidden.has(c.id);
  const name = calendarLabel(c);

  // #518: in the task view, each task list says whether its due tasks show in the calendar views.
  const inCalendar = !store.get('tasksHiddenInCalendar').has(c.id);
  const tasksInCalLabel = `Fällige Aufgaben von „${name}“ im Kalender anzeigen`;
  const tasksInCalBtnHtml = !taskView ? '' :
    `<button class="cal-action-btn" data-tasks-in-cal="${escHtml(c.id)}" aria-pressed="${inCalendar}" title="${escHtml(tasksInCalLabel)}" aria-label="${escHtml(tasksInCalLabel)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <polyline points="8 15 11 18 16 12"/>
          </svg>
        </button>`;

  const shareBtnHtml = c.isShared
    ? ''
    : `<button class="cal-action-btn" data-share-cal="${escHtml(c.id)}" title="Teilen & Link" aria-label="Teilen & Link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
            <polyline points="16 6 12 2 8 6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
          </svg>
        </button>`;

  // A read-only calendar can still get the user's own colour (#4), which is never synced (#505).
  const editLabel = c.readOnly ? 'Farbe ändern' : 'Umbenennen';
  const editBtnHtml =
    `<button class="cal-action-btn" data-edit-cal="${escHtml(c.id)}" title="${editLabel}" aria-label="${editLabel}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>`;

  const exportBtnHtml =
    `<button class="cal-action-btn" data-export-cal="${escHtml(c.id)}" title="Als ICS exportieren" aria-label="Als ICS exportieren">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>`;
        
  const googleBadge = c.source === 'google'
    ? `<svg class="google-badge-icon" viewBox="0 0 24 24" width="12" height="12" role="img" aria-label="Mit Google Kalender synchronisiert">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"/>
       </svg>`
    : '';

  const loadError = calendarLoadError(c);

  return `
    <div class="calendar-item${checked ? ' checked' : ''}" data-cal-id="${escHtml(c.id)}" data-order-group="${escHtml(orderGroup)}" tabindex="0" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${escHtml(loadError ? `${name} (Termine konnten nicht geladen werden: ${loadError.error})` : name)}">
      <div class="calendar-dot" style="background:${escHtml(sanitizeColor(c.color))}"></div>
      <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; justify-content: center; line-height: 1.2;">
        <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
          <span class="calendar-name" style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(name)}">${escHtml(name)}</span>
          ${googleBadge}
        </div>
        ${c.isShared ? `<span style="font-size: 0.65rem; color: var(--ink-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">von ${escHtml(c.owner)}</span>` : ''}
        ${c.formerLink ? `<span class="calendar-former-link">${escHtml(formerLinkLabel(c))}</span>` : ''}
        ${loadError ? `<span class="calendar-load-error" style="font-size: 0.65rem; color: var(--danger); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${escHtml(loadError.error)}">⚠ Nicht erreichbar – Termine fehlen</span>` : ''}
      </div>
      <div class="cal-item-actions">
        ${tasksInCalBtnHtml}
        ${shareBtnHtml}
        ${editBtnHtml}
        ${exportBtnHtml}
      </div>
      <div class="calendar-check" style="${checked ? 'background:' + escHtml(sanitizeColor(c.color)) : ''}">
        <svg class="calendar-check-icon" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" width="10" height="10" aria-hidden="true">
          <path d="M2 6l3 3 5-5"/>
        </svg>
      </div>
    </div>`;
}

// #500: the task view lists the collections holding tasks, every other view those holding events.
function inTaskView() {
  return store.get('view') === 'kanban';
}

// #504: stores a sidebar group's new order; when that fails the list is reloaded from the server.
// Saves run one after another; `orderEdits` counts them so a list request that overlaps one is repeated.
let orderSaves = Promise.resolve();
let orderEdits = 0;
function saveSidebarOrder(ids, reload) {
  orderEdits++;
  const previous = orderSaves;
  orderSaves = (async () => {
    await previous;
    try {
      await CalendarsAPI.saveOrder(ids);
    } catch (err) {
      showToast('Reihenfolge konnte nicht gespeichert werden: ' + err.message, 'error');
      // Not awaited: the reload itself waits for this save chain to settle.
      reload();
    }
  })();
}

// #504: a sidebar list as the server orders it once every pending order save is stored; a list
// fetched while the user reordered would undo that move, so it is fetched again.
async function listAfterOrderSaves(fetchList) {
  for (;;) {
    const edits = orderEdits;
    await orderSaves;
    const res = await fetchList();
    if (edits === orderEdits) return res;
  }
}

// #518: shows or hides a task list's due tasks in the calendar views; stored per user on the server.
async function toggleTasksInCalendar(calendarId) {
  const before = store.get('tasksHiddenInCalendar');
  const shown = before.has(calendarId);
  const next = new Set(before);
  if (shown) next.delete(calendarId);
  else next.add(calendarId);
  const apply = set => {
    store.set({ tasksHiddenInCalendar: set });
    renderCalendarList();
    const btn = [...$('calendar-list').querySelectorAll('[data-tasks-in-cal]')].find(b => b.dataset.tasksInCal === calendarId);
    if (btn) btn.focus();
  };
  apply(next);
  try {
    const prefs = await PreferencesAPI.setTaskListInCalendar(calendarId, shown);
    apply(new Set(prefs.tasksHiddenInCalendar));
    announce(shown ? 'Fällige Aufgaben werden im Kalender angezeigt' : 'Fällige Aufgaben werden im Kalender ausgeblendet');
  } catch (err) {
    apply(before);
    showToast('Die Einstellung konnte nicht gespeichert werden: ' + err.message, 'error');
  }
}

function renderCalendarList() {
  const list   = $('calendar-list');
  if (renderLater(list, renderCalendarList)) return;
  const hidden = store.get('hiddenCalendars');
  const taskView = inTaskView();
  const cals   = store.get('calendars').filter(taskView ? holdsTasks : holdsEvents);

  $('calendar-list-title').textContent = taskView ? 'Aufgabenlisten' : 'Kalender';
  const addLabel = taskView ? 'Aufgabenliste hinzufügen' : 'Kalender hinzufügen';
  $('add-calendar-btn').title = addLabel;
  $('add-calendar-btn').setAttribute('aria-label', addLabel);

  if (store.get('calendarsError')) {
    list.innerHTML = `<div style="font-size:0.78rem;color:var(--ink-muted);padding:4px 8px">${CALENDARS_LOAD_FAILED}</div>`;
    return;
  }
  if (!cals.length) {
    list.innerHTML = `<div style="font-size:0.78rem;color:var(--ink-muted);padding:4px 8px">${taskView ? 'Keine Aufgabenlisten gefunden.' : 'Keine Kalender gefunden.'}</div>`;
    return;
  }

  // #496: a linked account's calendars are grouped under the account's name.
  // #504: the user reorders calendars within their group.
  const focusedId = focusedItemId(list, 'calId');
  list.innerHTML = groupCalendarsByAccount(cals).map(group =>
    (group.label === null ? '' : `<div class="calendar-group-label">${escHtml(group.label)}</div>`) +
    group.calendars.map(c => calendarListItemHtml(c, hidden, c.linkedAccountId || 'own', taskView)).join('')
  ).join('');
  refocusItem(list, 'calId', focusedId);
  enableReorder(list, {
    itemSelector: '[data-cal-id]',
    idOf: el => el.dataset.calId,
    onReorder: ids => {
      store.set({ calendars: applyGroupOrder(store.get('calendars'), ids, c => c.id) });
      renderCalendarList();
      saveSidebarOrder(ids, loadCalendars);
    },
  });

  // Toggle visibility on main area click or keypress
  const onActionButton = target => target.closest('[data-edit-cal], [data-share-cal], [data-export-cal], [data-tasks-in-cal]');
  list.querySelectorAll('[data-cal-id]').forEach(el => {
    const handleToggle = e => {
      if (onActionButton(e.target)) return;
      toggleCalendar(el.dataset.calId);
      renderCalendarList();
      renderCalendarView();
    };

    el.addEventListener('click', handleToggle);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (onActionButton(e.target)) return;
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

  list.querySelectorAll('[data-tasks-in-cal]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleTasksInCalendar(btn.dataset.tasksInCal);
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

  const writableCals = (store.get('calendars') || []).filter(c => !c.readOnly && c.source !== 'google' && holdsEvents(c));
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
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
          <select id="import-cal-select" class="form-input"></select>
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

  fillCalendarSelect(backdrop.querySelector('#import-cal-select'), writableCals);
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
    let job;
    try {
      job = await CalendarsAPI.importICS(calId, icsText, null, strategy);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Importieren';
      showToast(err.message, 'error');
      return;
    }
    close();
    trackImportJob(job);
  });
}

// ── Import & sync progress (Issue #174) ──────────────────────────────────────
// Radicale's create cost grows with the collection, so a large first import or
// sync takes minutes. The banners show the worker's real counters; the calendar
// stays usable meanwhile.

const IMPORT_POLL_MS = 1000;
const SYNC_POLL_MS = 2000;
const formatCount = n => new Intl.NumberFormat('de-DE').format(n);

function renderImportProgress(job) {
  const banner = $('import-progress');
  if (!job) {
    banner.classList.add('hidden');
    return;
  }
  $('import-progress-text').textContent =
    `Import läuft: ${formatCount(job.processed)} von ${formatCount(job.total)} Terminen. Der Kalender ist schon nutzbar.`;
  const bar = $('import-progress-bar');
  bar.max = job.total;
  bar.value = job.processed;
  banner.classList.remove('hidden');
}

function finishImport(job) {
  renderImportProgress(null);
  if (job.status === 'error') {
    showToast(`Import abgebrochen nach ${formatCount(job.processed)} von ${formatCount(job.total)} Terminen: ${job.error}`, 'error');
  } else {
    const parts = [`${job.imported} importiert`];
    if (job.skipped) parts.push(`${job.skipped} übersprungen`);
    if (job.failed) parts.push(`${job.failed} fehlgeschlagen`);
    showToast(`Import abgeschlossen: ${parts.join(', ')}.`, job.failed ? 'error' : 'success');
  }
  invalidateEventCache();
  loadEvents();
}

async function trackImportJob(job) {
  while (job.status === 'running') {
    renderImportProgress(job);
    await new Promise(resolve => setTimeout(resolve, IMPORT_POLL_MS));
    try {
      job = await CalendarsAPI.getImportJob(job.id);
    } catch (err) {
      renderImportProgress(null);
      showToast('Der Importfortschritt konnte nicht abgerufen werden: ' + err.message, 'error');
      return;
    }
  }
  finishImport(job);
}

let syncPollTimer = null;
let syncWasRunning = false;

// A running sync job shows how many events it has written; once it ends, the
// calendar reloads so the synced events appear.
function renderSyncProgress(jobs) {
  const running = jobs.find(j => j.status === 'RUNNING');
  const banner = $('sync-progress');
  if (running && running.itemsDone > 0) {
    $('sync-progress-text').textContent =
      `Synchronisierung läuft: ${formatCount(running.itemsDone)} Termine übertragen. Der Kalender ist schon nutzbar.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  if (syncWasRunning && !running) {
    invalidateEventCache();
    loadEvents();
  }
  syncWasRunning = Boolean(running);
  if (running && syncPollTimer === null) {
    syncPollTimer = setTimeout(() => { syncPollTimer = null; checkSyncStatus(); }, SYNC_POLL_MS);
  }
}

function openEditCalendarDialog(cal) {
  document.getElementById('edit-cal-dialog-backdrop')?.remove();
  // Read-only: only the user's local colour override, never the name (#4, #505).
  const colorOnly = Boolean(cal.readOnly);

  const backdrop = document.createElement('div');
  backdrop.id = 'edit-cal-dialog-backdrop';
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="edit-cal-dialog-title">
      <div class="modal-header">
        <h3 class="modal-title" id="edit-cal-dialog-title">${colorOnly ? `Farbe von „${escHtml(cal.name)}“` : `${collectionNoun(cal)} bearbeiten`}</h3>
        <button class="icon-btn" id="edit-cal-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <form id="edit-cal-form" novalidate>
          ${colorOnly ? '' : `<div class="form-group">
            <label class="form-label" for="edit-cal-name">Name</label>
            <input class="form-input" id="edit-cal-name" type="text"
                   value="${escHtml(cal.name)}" required />
          </div>`}
          <div class="form-group">
            <label class="form-label" for="edit-cal-color">Farbe</label>
            <input class="form-input" id="edit-cal-color" type="color"
                   value="${escHtml(sanitizeColor(cal.color, '#007080'))}"
                   ${colorOnly ? 'aria-describedby="edit-cal-color-hint"' : ''}
                   style="height:40px;padding:4px 8px;cursor:pointer;" />
            ${colorOnly ? '<p class="form-hint" id="edit-cal-color-hint">Nur für dich. Die Farbe wird nicht synchronisiert.</p>' : ''}
          </div>
          <div id="edit-cal-error" class="form-error hidden" role="alert"></div>
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
    if (colorOnly) document.getElementById('edit-cal-color')?.focus();
    nameInput?.focus();
    nameInput?.select();
  }, 50);

  backdrop.querySelector('#edit-cal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name  = colorOnly ? cal.name : document.getElementById('edit-cal-name').value.trim();
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
      await CalendarsAPI.update(cal.id, colorOnly ? { color } : { name, color });
      // Optimistic update in store
      const cals = store.get('calendars').map(c =>
        c.id === cal.id ? { ...c, name, color } : c
      );
      store.set({ calendars: cals });
      noteLocalEdit('calendars');
      close();
      showToast(colorOnly ? 'Farbe gespeichert.' : `${collectionNoun(cal)} umbenannt in „${name}“.`, 'success');
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
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
            <button class="btn btn-ghost" id="public-link-regen-btn" title="Link neu generieren (alter Link verfällt)" aria-label="Link neu generieren (alter Link verfällt)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/>
              </svg>
            </button>
          </div>
          <div class="form-group hidden" id="public-link-detail-group" style="margin-top: var(--sp-2);">
            <label class="form-label" for="public-link-detail">Sichtbare Details</label>
            <select class="form-input" id="public-link-detail">
              <option value="busy">Nur frei/belegt</option>
              <option value="full">Alle Details (ohne private Termine und Teilnehmende)</option>
            </select>
          </div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(backdrop);
  openDialog(backdrop);
  const closeCleanups = [];
  const close = () => {
    closeCleanups.forEach(cleanup => cleanup());
    closeDialog(backdrop);
    backdrop.remove();
  };
  backdrop.querySelector('#share-cal-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const publicEnable = backdrop.querySelector('#public-link-enable');
  const publicArea   = backdrop.querySelector('#public-link-area');
  const publicInput  = backdrop.querySelector('#public-link-input');
  const publicCopy   = backdrop.querySelector('#public-link-copy-btn');
  const publicRegen  = backdrop.querySelector('#public-link-regen-btn');
  const publicDetailGroup = backdrop.querySelector('#public-link-detail-group');
  const publicDetail = backdrop.querySelector('#public-link-detail');

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

    // Issue #229: document outlives the dialog, so close() must take this handler back.
    const hideDropdownOnOutsideClick = e => {
      if (!e.target.closest('.autocomplete-container')) {
        hideDropdown();
      }
    };
    document.addEventListener('click', hideDropdownOnOutsideClick);
    closeCleanups.push(() => document.removeEventListener('click', hideDropdownOnOutsideClick));

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
                <button class="icon-btn cal-action-delete btn-revoke-share" data-href="${escHtml(s.href)}" title="Entfernen" style="padding:4px;" aria-label="Entfernen">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
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
              showToast(e.message, 'error');
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
  let savedPublicDetail = 'busy';

  async function loadPublicLink() {
    const seq = ++publicLinkSeq;
    try {
      const data = await CalendarsAPI.getPublicLink(cal.id);
      if (seq !== publicLinkSeq) return;
      if (data.enabled) {
        publicEnable.checked = true;
        publicArea.classList.remove('hidden');
        publicDetailGroup.classList.remove('hidden');
        publicInput.value = data.url;
        publicDetail.value = savedPublicDetail = data.detail;
      } else {
        publicEnable.checked = false;
        publicArea.classList.add('hidden');
        publicDetailGroup.classList.add('hidden');
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
        publicDetailGroup.classList.remove('hidden');
        publicInput.value = data.url;
        publicDetail.value = savedPublicDetail = data.detail;
        showToast('Öffentlicher Link aktiviert.', 'success');
      } else {
        await CalendarsAPI.disablePublicLink(cal.id);
        if (seq !== publicLinkSeq) return;
        publicArea.classList.add('hidden');
        publicDetailGroup.classList.add('hidden');
        publicInput.value = '';
        showToast('Öffentlicher Link deaktiviert.', 'info');
      }
    } catch (e) {
      if (seq !== publicLinkSeq) return;
      showToast('Änderung fehlgeschlagen: ' + e.message, 'error');
      publicEnable.checked = !targetState;
    }
  });

  publicDetail.addEventListener('change', async () => {
    const seq = ++publicLinkSeq;
    const detail = publicDetail.value;
    try {
      await CalendarsAPI.setPublicLinkDetail(cal.id, detail);
      savedPublicDetail = detail;
      if (seq !== publicLinkSeq) return;
      showToast(detail === 'full' ? 'Abonnement zeigt jetzt alle Details.' : 'Abonnement zeigt jetzt nur frei/belegt.', 'success');
    } catch (e) {
      if (seq !== publicLinkSeq) return;
      showToast('Änderung fehlgeschlagen: ' + e.message, 'error');
      publicDetail.value = savedPublicDetail;
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
  renderSettingsHolidays().catch(err => showToast('Feiertage konnten nicht geladen werden: ' + err.message, 'error'));
  renderSettingsNotifications();
  renderSettingsTrash();
}

function renderSettingsNotifications() {
  const statusEl = $('notification-status-text');
  const btn = $('request-notification-btn');
  if (!statusEl || !btn) return;

  if (typeof Notification === 'undefined') {
    statusEl.textContent = 'Status: Nicht unterstützt';
    btn.classList.add('hidden');
    return;
  }

  if (Notification.permission === 'granted') {
    statusEl.textContent = 'Status: Aktiviert';
    btn.textContent = 'Aktiviert';
    btn.disabled = true;
    btn.classList.remove('hidden');
  } else if (Notification.permission === 'denied') {
    statusEl.textContent = 'Status: Blockiert';
    btn.textContent = 'Blockiert';
    btn.disabled = true;
    btn.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Status: Nicht aktiviert';
    btn.textContent = 'Aktivieren';
    btn.disabled = false;
    btn.classList.remove('hidden');
  }
}

// #509: the second time zone is switched on by choosing a zone and off by the checkbox.
function renderSettingsTimezone() {
  const zone = store.get('secondaryTimezone');
  $('show-secondary-tz-toggle').checked = Boolean(zone);
  $('secondary-tz-picker').classList.toggle('hidden', !zone);
  $('secondary-tz-current').textContent = zone
    ? `Gewählt: ${zone} (${zoneOffsetLabel(zone, new Date())})`
    : 'Noch keine Zeitzone gewählt.';
  $('secondary-tz-search').value = '';
  $('secondary-tz-results').innerHTML = '';
}

function renderSecondaryTimezoneResults(query) {
  const now = new Date();
  $('secondary-tz-results').innerHTML = searchTimeZones(query).map(zone => `
    <li><button type="button" data-tz="${escHtml(zone)}">
      <span>${escHtml(zone)}</span><span class="tz-result-offset">${zoneOffsetLabel(zone, now)}</span>
    </button></li>`).join('');
}

async function changeSecondaryTimezone(zone) {
  const saved = (await PreferencesAPI.setSecondaryTimezone(zone)).secondaryTimezone;
  store.set({ secondaryTimezone: saved });
  renderSettingsTimezone();
  renderCalendarView();
  announce(saved ? `Zweite Zeitzone: ${saved}` : 'Zweite Zeitzone ausgeblendet');
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
      const dateStr = new Date(asp.createdAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      return `
        <div class="settings-item" style="padding: 6px 0">
          <div class="settings-item-info" style="display:flex; flex-direction:column; align-items:flex-start">
            <span style="font-weight: 500">${escHtml(asp.label)}</span>
            <span style="font-size: 10px; color:var(--ink-muted)">Erstellt am ${dateStr}</span>
          </div>
          <div class="settings-item-actions">
            <button class="settings-action-btn btn-danger" data-delete-asp="${escHtml(asp.id)}" title="Passwort löschen" style="padding:4px" aria-label="Passwort löschen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
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

// Issue #198: the sync worker's job history, shown next to a linked Google
// account. Jobs are per user (one run syncs all Google accounts), so every
// Google account shows the same state. No success at all is shown too — that is
// the only sign of a job stranded in RUNNING (#62). `jobs` is undefined until
// the first status poll has answered.
function accountSyncStatusHtml(jobs) {
  if (!jobs) return '';
  const fmt = ms => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Server orders by created_at DESC.
  const latestFinished = jobs.find(j => j.status === 'SUCCESS' || j.status === 'ERROR');
  const lastSuccess = jobs.find(j => j.status === 'SUCCESS');
  const lines = [];
  if (latestFinished && latestFinished.status === 'ERROR') {
    lines.push(`<div style="color:var(--danger, #ef4444)">Synchronisation fehlgeschlagen am ${escHtml(fmt(latestFinished.updatedAt))}: ${escHtml(latestFinished.errorMessage || 'unbekannter Fehler')}</div>`);
  }
  lines.push(lastSuccess
    ? `<div>Zuletzt erfolgreich synchronisiert: ${escHtml(fmt(lastSuccess.updatedAt))}</div>`
    : '<div>Noch keine erfolgreiche Synchronisation</div>');
  return `<div class="account-sync-status" style="color:var(--ink-muted); font-size:0.68rem; margin-top:2px;">${lines.join('')}</div>`;
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
  const syncJobs = store.get('syncJobs');

  list.innerHTML = accounts.map(a => {
    // Issue #136: credentials could not be decrypted (e.g. ENCRYPTION_KEY changed after a restore).
    // The account is unusable; offer only deletion so the user can reconnect it.
    if (a.credentialsUnreadable) {
      return `
      <div class="settings-item">
        <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
          <div class="settings-item-info">
            <div class="account-dot" style="width:8px; height:8px; border-radius:50%; background:var(--danger, #ef4444); flex-shrink:0"></div>
            <span class="settings-item-name" title="${escHtml(a.url)}">${escHtml(a.displayName || a.username)}</span>
          </div>
          <div style="color:var(--danger, #ef4444); font-size:0.68rem; margin-top:2px;">Zugangsdaten nicht lesbar — Konto neu verbinden</div>
        </div>
        <div class="settings-item-actions">
          <button class="settings-action-btn btn-danger" data-delete-acc="${escHtml(a.id)}" title="Account entfernen" aria-label="Account entfernen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>`;
    }
    const isEnvDefault = a.id === 'env-default';
    const errObj = errors.find(e => e.accountId === a.id);
    const hasError = !!errObj;

    const reconnectBtn = (hasError && a.url.includes('googleusercontent.com'))
      ? `<button class="settings-action-btn" data-reconnect-acc="${escHtml(a.id)}" title="Verbindung wiederherstellen" style="color:var(--warning, #f59e0b)" aria-label="Verbindung wiederherstellen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/>
          </svg>
         </button>`
      : '';

    const editBtn = isEnvDefault
      ? ''
      : `<button class="settings-action-btn" data-edit-acc="${escHtml(a.id)}" title="Umbenennen" aria-label="Umbenennen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
         </button>`;

    const deleteBtn = isEnvDefault
      ? ''
      : `<button class="settings-action-btn btn-danger" data-delete-acc="${escHtml(a.id)}" title="Account entfernen" aria-label="Account entfernen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
         </button>`;

    const errorHtml = hasError
      ? `<div style="color:var(--danger, #ef4444); font-size:0.68rem; margin-top:2px; display:flex; align-items:center; gap:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="flex-shrink:0" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>
          </svg>
          Verbindungsfehler
         </div>`
      : '';

    const syncHtml = a.url.includes('googleusercontent.com') ? accountSyncStatusHtml(syncJobs) : '';

    return `
      <div class="settings-item">
        <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
          <div class="settings-item-info">
            <div class="account-dot" style="width:8px; height:8px; border-radius:50%; background:var(--line); flex-shrink:0"></div>
            <span class="settings-item-name" title="${escHtml(a.url)}">${escHtml(a.displayName || a.username)}</span>
          </div>
          ${errorHtml}
          ${syncHtml}
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
      if (!(await confirmDialog(`Möchtest du den Account „${acc.displayName || acc.username}“ wirklich entfernen? Die Synchronisation endet; die Kalender bleiben als eigene Kalender erhalten, beim Anbieter wird nichts gelöscht.`))) return;
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

  if (store.get('calendarsError')) {
    list.innerHTML = `<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">${CALENDARS_LOAD_FAILED}</div>`;
    return;
  }
  if (!cals.length) {
    list.innerHTML = '<div style="font-size:0.75rem;color:var(--ink-muted);padding:4px">Keine Kalender gefunden.</div>';
    return;
  }

  list.innerHTML = cals.map(c => {
    const deleteBtn = (c.isShared || c.readOnly || c.id.includes('env-default'))
      ? ''
      : `<button class="settings-action-btn btn-danger" data-delete-cal-settings="${escHtml(c.id)}" title="${collectionNoun(c)} löschen" aria-label="${collectionNoun(c)} löschen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
         </button>`;

    const googleBadge = c.source === 'google'
      ? `<svg class="google-badge-icon" viewBox="0 0 24 24" width="12" height="12" role="img" aria-label="Mit Google Kalender synchronisiert">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"/>
         </svg>`
      : '';

    // #614: a mirror in the shard's own Radicale can be disconnected on its own.
    const disconnectBtn = c.linkedAccountId && c.accountId === 'internal-caldav'
      ? `<button class="settings-action-btn" data-disconnect-cal="${escHtml(c.id)}">Verbindung trennen</button>`
      : '';

    return `
      <div class="settings-item">
        <div style="display:flex; flex-direction:column; min-width:0; flex:1;">
          <div class="settings-item-info">
            <div class="calendar-dot" style="background:${escHtml(sanitizeColor(c.color))}; width:8px; height:8px; border-radius:50%; flex-shrink:0"></div>
            <span class="settings-item-name" title="${escHtml(calendarLabel(c))}">${escHtml(calendarLabel(c))}</span>
            <span class="settings-item-type">${collectionTypeLabel(c)}</span>
            ${googleBadge}
            ${c.formerLink ? `<span class="calendar-former-link">${escHtml(formerLinkLabel(c))}</span>` : ''}
          </div>
        </div>
        <div class="settings-item-actions">
          ${disconnectBtn}
          ${deleteBtn}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-disconnect-cal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cal = cals.find(c => c.id === btn.dataset.disconnectCal);
      if (!cal) return;
      if (!(await confirmDialog(`Verbindung von „${cal.name}“ zum Konto trennen? Der Kalender bleibt mit allen Terminen als eigener Kalender erhalten, beim Anbieter wird nichts gelöscht.`))) return;
      try {
        await AccountsAPI.disconnectMirror(cal.href.replace(/\/$/, '').split('/').pop());
        showToast(`„${cal.name}“ ist nicht mehr verknüpft.`, 'info');
        await loadCalendars();
        renderSidebar();
        renderSettingsCalendars();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Delete Calendar from Settings
  list.querySelectorAll('[data-delete-cal-settings]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteCalSettings;
      const cal = cals.find(c => c.id === id);
      if (!cal) return;
      const noun = collectionNoun(cal);
      const content = noun === 'Aufgabenliste' ? 'Aufgaben' : 'Termine';
      if (!(await typedConfirmDialog(
        `${noun} „${cal.name}“ und alle darin enthaltenen ${content} löschen? Sie liegen danach 30 Tage im Papierkorb. Gib zur Bestätigung den Namen ein:`,
        cal.name, `${noun} löschen`))) return;
      try {
        const { trashId } = await CalendarsAPI.remove(id);
        store.set({ calendars: store.get('calendars').filter(c => c.id !== id) });
        noteLocalEdit('calendars');
        showUndoToast(`${noun} „${cal.name}“ in den Papierkorb verschoben.`, trashId);
        renderSettingsTrash();
        invalidateEventCache();
        await loadEvents();
        renderSidebar();
        renderCalendarView();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ── Add Calendar Dialog ───────────────────────────────────────────────────────

function openAddCalendarDialog() {
  // Remove any existing dialog first
  document.getElementById('add-cal-dialog-backdrop')?.remove();

  const accounts = store.get('accounts').filter(a => !a.credentialsUnreadable);
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
        <h3 class="modal-title" id="add-cal-dialog-title"></h3>
        <button class="icon-btn modal-close" id="add-cal-close" aria-label="Schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <form id="add-cal-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="add-cal-name">Name</label>
            <input class="form-input" id="add-cal-name" type="text" required autofocus />
          </div>
          <div class="form-group">
            <label class="form-label" for="add-cal-type">Typ</label>
            <select class="form-select" id="add-cal-type">
              <option value="calendar">Kalender (Termine)</option>
              <option value="tasklist">Aufgabenliste (Aufgaben)</option>
              <option value="mixed">Gemischt (Termine und Aufgaben)</option>
            </select>
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
          <div id="add-cal-error" class="form-error hidden" role="alert"></div>
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

  // #500: created in the task view it is an Aufgabenliste, otherwise a Kalender.
  const ADD_TYPE_TEXT = {
    calendar: { title: 'Neuer Kalender', placeholder: 'Mein Kalender', created: 'Kalender' },
    tasklist: { title: 'Neue Aufgabenliste', placeholder: 'Meine Aufgaben', created: 'Aufgabenliste' },
    mixed:    { title: 'Neuer gemischter Kalender', placeholder: 'Termine und Aufgaben', created: 'Kalender' },
  };
  const typeSelect = backdrop.querySelector('#add-cal-type');
  const applyType = () => {
    const text = ADD_TYPE_TEXT[typeSelect.value];
    backdrop.querySelector('#add-cal-dialog-title').textContent = text.title;
    backdrop.querySelector('#add-cal-name').placeholder = text.placeholder;
  };
  typeSelect.value = inTaskView() ? 'tasklist' : 'calendar';
  applyType();
  typeSelect.addEventListener('change', applyType);

  const closeDialog = () => backdrop.remove();

  backdrop.querySelector('#add-cal-close').addEventListener('click', closeDialog);
  backdrop.querySelector('#add-cal-cancel').addEventListener('click', closeDialog);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeDialog(); });

  backdrop.querySelector('#add-cal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name      = document.getElementById('add-cal-name').value.trim();
    const color     = document.getElementById('add-cal-color').value;
    const accountId = document.getElementById('add-cal-account').value;
    const type      = typeSelect.value;

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
      await CalendarsAPI.create({ accountId, name, color, type });
      closeDialog();
      showToast(`${ADD_TYPE_TEXT[type].created} „${name}“ erstellt.`, 'success');
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
  const color   = ev.color || cal.color || '#6366f1';

  const timeStr = ev.allDay
    ? 'Ganztägig'
    : `${fmt(ev.start)} – ${fmt(ev.end)}`;

  const attHtml = ev.attendees?.length
    ? `<div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <span>${ev.attendees.map(a => escHtml(a.name || a.email)).join(', ')}</span>
       </div>`
    : '';

  // Only http(s)/mailto attachments become links; escaping alone does not stop `javascript:` (issue #338).
  const linkAttachments = Array.isArray(ev.attachments) ? ev.attachments.filter(a => a && isSafeLinkUrl(a.url)) : [];
  const attachHtml = linkAttachments.length > 0
    ? `<div class="popover-row popover-attachments" id="popover-attachments">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        <div style="display:flex; flex-direction:column; gap:2px;">
          ${linkAttachments.map(a => `
            <a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="attachment-drive-link" style="color:var(--accent); font-size:12px; text-decoration:underline;">${escHtml(a.name || a.url)}</a>
          `).join('')}
        </div>
       </div>`
    : '';

  const isReadOnly = ev.readOnly || ev.isSubscription || cal.readOnly;
  const actionsHtml = isReadOnly
    ? `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Details</button>
       <span style="font-size:11px;color:var(--danger);margin-left:auto;padding-right:8px;font-weight:600;">${ev.isSubscription ? 'Abonnement (schreibgeschützt)' : 'Schreibgeschützt'}</span>`
    : `<button class="btn btn-ghost btn-sm" id="popover-edit-btn">Bearbeiten</button>
       <button class="btn btn-ghost btn-sm btn-danger" id="popover-delete-btn">Löschen</button>`;

  popover.innerHTML = `
    <div class="popover-color-bar" style="background:${escHtml(sanitizeColor(color))}"></div>
    <div class="popover-title" id="popover-title">${escHtml(ev.title)}</div>
    <div class="popover-meta">
      <div class="popover-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <span>${timeStr}</span>
      </div>
      ${ev.location ? `<div class="popover-row popover-location">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
        <span>${escHtml(ev.location)}</span>
      </div>` : ''}
      ${ev.description ? `<div class="popover-row popover-description" style="margin-top:4px; font-size:12px; color:var(--text-muted);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
        <span>${escHtml(ev.description)}</span>
      </div>` : ''}
      ${attHtml}
      ${attachHtml}
    </div>
    <div class="popover-actions">
      ${actionsHtml}
    </div>`;

  // Position near mouse or target element if keyboard activated
  _popoverUid = ev.uid;
  announce(`Termindetails: ${ev.title}`);

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
      openEditModal(ev, EVENT_MODAL_CALLBACKS);
    };
  }

  const deleteBtn = $('popover-delete-btn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const recId = ev.recurrenceId || (ev.uid && ev.uid.includes('::') ? ev.uid.split('::')[1] : null);
      let scope = 'series';
      // The question names the event; the popover would otherwise sit over the dialog's buttons.
      closePopover();
      if (recId) {
        scope = await chooseRecurrenceScope(`„${ev.title}“ löschen:`);
        if (!scope) return;
      } else {
        if (!(await confirmDialog(`„${ev.title}“ löschen?`))) return;
      }
      try {
        const targetUid = ev.masterUid || (ev.uid ? ev.uid.split('::')[0] : '');
        const { trashId } = await EventsAPI.remove(targetUid, {
          calendarId: ev.calendarId, etag: ev.etag, href: ev.href,
          ...(scope === 'occurrence' ? { scope, recurrenceId: recId } : {})
        });
        onEventDeleted(targetUid);
        // A deleted occurrence is an EXDATE in the series, not a trash entry.
        if (trashId) showUndoToast('Termin gelöscht.', trashId);
        else showToast('Termin gelöscht.', 'info');
      } catch(err) { showToast(err.message, 'error'); }
    };
  }

  // Through the dialog manager (#266): it records the chip for focus return, clears the
  // `inert` the last close left, and makes Escape and the Tab trap reach the popover.
  openDialog(popover, editBtn);
}

function closePopover({ restoreFocus = true } = {}) {
  closeDialog($('event-popover'), { restoreFocus });
  _popoverUid = null;
}

// ── Event callbacks ───────────────────────────────────────────────────────────

// The preview stays on screen until the reload brings the saved event (#174).
async function onEventSaved(savedEvent, pendingToken) {
  const entry = pendingSaves.get(pendingToken);
  pendingSaves.delete(pendingToken);
  invalidateEventCache();
  await loadEvents();
  // An edited occurrence keeps its instance uid; a new event has the server's.
  entry?.resolve(entry.replacesUid || savedEvent?.uid || null);
}

function onEventDeleted(uid) {
  invalidateEventCache();
  loadEvents();
}

const EVENT_MODAL_CALLBACKS = {
  onSaved: onEventSaved,
  onDeleted: onEventDeleted,
  onPending: onEventPending,
  onSettled: settlePendingSave
};

// ── Drag and drop of events (#574) ───────────────────────────────────────────

// True when the user may change the event (write access to its calendar; the server checks the
// same), otherwise the notice a drag attempt shows.
function eventDragPermission(ev) {
  const cal = calendarsById()[ev.calendarId] || {};
  if (!ev.readOnly && !ev.isSubscription && !cal.readOnly) return true;
  if (ev.kind === 'task') return `Nur lesbar: Aufgabe aus ${cal.name || 'einer anderen Liste'}`;
  const organizer = ev.organizer?.name || ev.organizer?.email || cal.name || 'einem anderen Kalender';
  return `Nur lesbar: Termin von ${organizer}`;
}

// Ja → true, Nein → false, closed → null (the drop is undone).
function askNotifyAttendees() {
  return new Promise(resolve => {
    const bd = $('notify-dialog-backdrop');
    const buttons = { 'notify-yes-btn': true, 'notify-no-btn': false, 'notify-cancel-btn': null };
    const listeners = Object.entries(buttons).map(([id, value]) => {
      const fn = () => {
        listeners.forEach(([bid, f]) => $(bid).removeEventListener('click', f));
        closeDialog(bd);
        resolve(value);
      };
      $(id).addEventListener('click', fn);
      return [id, fn];
    });
    openDialog(bd, $('notify-yes-btn'));
  });
}

const recurrenceIdOf = ev => ev.recurrenceId || (ev.uid?.includes('::') ? ev.uid.split('::')[1] : null);
const masterUidOf = ev => ev.masterUid || ev.uid.split('::')[0];

async function onEventDrop(ev, change) {
  if (ev.kind === 'task') return onTaskDrop(ev.task, change);
  const recurrenceId = recurrenceIdOf(ev);
  let scope = null;
  if (recurrenceId) {
    scope = await chooseRecurrenceScope(`„${ev.title}“ verschieben:`);
    // Cancelling puts the event back: the view is drawn from the unchanged state.
    if (!scope) { renderCalendarView(); return; }
  }
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  let sendAttendees = attendees;
  if (attendees.length > 0) {
    const notify = await askNotifyAttendees();
    if (notify === null) { renderCalendarView(); return; }
    // Informing asks every attendee again: their answer goes back to open (an invitation in their
    // inbox, and for CalDAV scheduling clients a new request).
    const organizer = (ev.organizer?.email || '').toLowerCase();
    if (notify) {
      sendAttendees = attendees.map(a => (a.email || '').toLowerCase() === organizer
        ? a : { ...a, status: 'NEEDS-ACTION', rsvp: true });
    }
  }
  const before = { start: ev.start, end: ev.end, allDay: Boolean(ev.allDay) };
  if (!(await saveEventTimes(ev, change, { scope, recurrenceId, attendees: sendAttendees }))) return;
  announce(`„${ev.title}“ verschoben.`);
  showUndoBar(async () => {
    const now = (store.get('events') || []).find(x => x.uid === ev.uid)
      || (store.get('events') || []).find(x => masterUidOf(x) === masterUidOf(ev)
        && new Date(x.start).getTime() === new Date(change.start).getTime());
    if (!now) {
      showToast(`„${ev.title}“ konnte nicht zurückgesetzt werden: Der Termin ist nicht mehr geladen.`, 'error');
      return;
    }
    await saveEventTimes(now, before, { scope, recurrenceId: recurrenceIdOf(now), attendees });
  });
}

// Optimistic save of new times (#174): drawn at once, rolled back with an error toast on failure.
async function saveEventTimes(ev, change, { scope, recurrenceId, attendees }) {
  const zone = ev.allDay ? localTimeZone() : null;
  const payload = {
    uid: masterUidOf(ev), calendarId: ev.calendarId, sourceCalendarId: ev.calendarId,
    href: ev.href, etag: ev.etag,
    title: ev.title, location: ev.location ?? null, description: ev.description ?? null,
    categories: ev.categories, attendees, alarms: ev.alarms, attachments: ev.attachments,
    transp: ev.transp, classification: ev.classification,
    recurrence: scope === 'occurrence' ? null : (ev.recurrence ?? null),
    start: change.start, end: change.end, allDay: change.allDay,
    startTimeZone: change.allDay ? null : (ev.startTimeZone || zone),
    endTimeZone: change.allDay ? null : (ev.endTimeZone || zone),
    ...(scope ? { scope, recurrenceId } : {})
  };
  const token = onEventPending({ ...ev, start: change.start, end: change.end, allDay: change.allDay, attendees }, ev.uid);
  try {
    const saved = await EventsAPI.update(payload.uid, payload);
    await onEventSaved(saved, token);
    return true;
  } catch (err) {
    settlePendingSave(token);
    const reason = err.status === 409
      ? 'Konflikt: Der Termin wurde von einem anderen Client geändert. Seite neu laden.'
      : err.message;
    showToast(`„${ev.title}“ wurde nicht verschoben. ${reason}`, 'error');
    return false;
  }
}

// ── Tasks in the calendar (#577) ─────────────────────────────────────────────
// An open task with a due date shows on that day: a date-only due in the all-day row, a due time
// as a 30-minute block from that time. It moves like an event (no edges); DTSTART moves along by
// the same days and minutes, so start and due keep their distance and their value type.

const TASK_ITEM_PREFIX = 'task:';

// #515: right-click (or the menu key) on an event in the calendar views, or on a task in the task
// area, the calendar grid or the sidebar, offers "Duplizieren".
function initItemContextMenu() {
  document.addEventListener('contextmenu', e => {
    const chip = e.target.closest('#calendar-container [data-event-uid]');
    const taskEl = e.target.closest('[data-task-id]');
    let duplicate = null;
    if (chip) {
      const uid = chip.dataset.eventUid;
      if (uid.startsWith(TASK_ITEM_PREFIX)) {
        const task = (store.get('tasks') || []).find(t => TASK_ITEM_PREFIX + t.uid === uid);
        if (task && !task.pending) duplicate = () => openDuplicateTaskModal(task);
      } else {
        const ev = (store.get('events') || []).find(x => x.uid === uid);
        if (ev && !ev.pending) duplicate = () => openDuplicateModal(ev, EVENT_MODAL_CALLBACKS);
      }
    } else if (taskEl && !taskEl.dataset.recurrenceId) {
      const task = (store.get('tasks') || []).find(t => t.uid === taskEl.dataset.taskId && !t.recurrenceId);
      if (task && !task.pending) duplicate = () => openDuplicateTaskModal(task);
    }
    if (!duplicate) return;
    e.preventDefault();
    // A menu opened by keyboard (clientX/Y 0) sits at the item.
    const item = chip || taskEl;
    const anchor = item.getBoundingClientRect();
    openContextMenu(e.clientX || anchor.left, e.clientY || anchor.bottom, [{ label: 'Duplizieren', action: duplicate }], item);
  });
}
const TASK_BLOCK_MS = 30 * 60000;

const dayString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// A date-only value is stored as midnight UTC of that date; its day is the local date of the same number.
const taskInstant = (value, isDate) => {
  const d = new Date(value);
  return isDate ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : d;
};
const taskValue = (d, isDate) => (isDate ? `${dayString(d)}T00:00:00.000Z` : d.toISOString());

function calendarTaskItems() {
  // #518: each task list can keep its due tasks out of the calendar views.
  const offCalendar = store.get('tasksHiddenInCalendar');
  return getFilteredTasks()
    .filter(t => t.due && t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && !offCalendar.has(t.calendarId))
    .map(t => {
      const due = taskInstant(t.due, t.dueIsDate);
      const times = t.dueIsDate
        ? { allDay: true, start: dayString(due), end: dayString(new Date(due.getFullYear(), due.getMonth(), due.getDate() + 1)) }
        : { allDay: false, start: due.toISOString(), end: new Date(due.getTime() + TASK_BLOCK_MS).toISOString() };
      return { uid: TASK_ITEM_PREFIX + t.uid, kind: 'task', task: t, title: t.title, calendarId: t.calendarId,
        recurrence: t.recurrence || null, pending: Boolean(t.pending), ...times };
    });
}

const taskTimes = t => ({ due: t.due, dueIsDate: Boolean(t.dueIsDate), dtstart: t.dtstart ?? null, dtstartIsDate: Boolean(t.dtstartIsDate) });

// The new DUE from the drop; DTSTART shifted by the same calendar days and wall-clock minutes.
function movedTaskTimes(task, change) {
  const oldDue = taskInstant(task.due, task.dueIsDate);
  const newDue = change.allDay ? taskInstant(`${change.start}T00:00:00.000Z`, true) : new Date(change.start);
  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(newDue) - midnight(oldDue)) / (24 * 3600 * 1000));
  const minutes = change.allDay || task.dueIsDate ? 0
    : (newDue.getHours() * 60 + newDue.getMinutes()) - (oldDue.getHours() * 60 + oldDue.getMinutes());
  const times = { due: taskValue(newDue, change.allDay), dueIsDate: change.allDay, dtstart: null, dtstartIsDate: false };
  if (task.dtstart) {
    const start = taskInstant(task.dtstart, task.dtstartIsDate);
    start.setDate(start.getDate() + days);
    start.setMinutes(start.getMinutes() + minutes);
    times.dtstart = taskValue(start, change.allDay);
    times.dtstartIsDate = change.allDay;
  }
  return times;
}

async function onTaskDrop(task, change) {
  const before = taskTimes(task);
  if (!(await saveTaskTimes(task, movedTaskTimes(task, change)))) return;
  announce(`„${task.title}“ verschoben.`);
  showUndoBar(async () => {
    const now = (store.get('tasks') || []).find(t => t.uid === task.uid);
    if (!now) {
      showToast(`„${task.title}“ konnte nicht zurückgesetzt werden: Die Aufgabe ist nicht mehr geladen.`, 'error');
      return;
    }
    await saveTaskTimes(now, before);
  });
}

// Optimistic like saveEventTimes: drawn at once, rolled back with an error toast on failure.
async function saveTaskTimes(task, times) {
  const replace = next => store.set({ tasks: (store.get('tasks') || []).map(t => (t.uid === task.uid ? next : t)) });
  replace({ ...task, ...times, pending: true });
  renderCalendarView();
  try {
    await TasksAPI.update(task.uid, { ...task, ...times, href: task.href, etag: task.etag, calendarId: task.calendarId });
  } catch (err) {
    replace(task);
    renderCalendarView();
    const reason = err.status === 409
      ? 'Konflikt: Die Aufgabe wurde von einem anderen Client geändert. Seite neu laden.'
      : err.message;
    showToast(`„${task.title}“ wurde nicht verschoben. ${reason}`, 'error');
    return false;
  }
  await reloadTasksAfterEdit();
  return true;
}

let undoTimer = null;

// "Verschoben · Rückgängig" for about 8 s after a drop.
function showUndoBar(onUndo) {
  const bar = $('undo-bar');
  const btn = $('undo-bar-btn');
  clearTimeout(undoTimer);
  bar.classList.remove('hidden');
  btn.onclick = () => {
    clearTimeout(undoTimer);
    bar.classList.add('hidden');
    btn.onclick = null;
    onUndo();
  };
  undoTimer = setTimeout(() => { bar.classList.add('hidden'); btn.onclick = null; }, 8000);
}

// ── UI Event Listeners ────────────────────────────────────────────────────────

function attachListeners() {
  $('sync-error-dismiss').addEventListener('click', dismissSyncError);

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
    renderCalendarList();
    const viewLabels = {
      month: 'Monatsansicht',
      week: 'Wochenansicht',
      workweek: 'Arbeitswoche',
      day: 'Tagesansicht',
      agenda: 'Agendaansicht',
      list: 'Listenansicht',
      kanban: 'Aufgaben'
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

  initPdfExport({ showToast });


  // New event button
  $('new-event-btn').addEventListener('click', () => {
    openCreateModal(store.get('currentDate') || new Date(), EVENT_MODAL_CALLBACKS);
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

  // Notification Permission Settings Control
  const reqNotifBtn = $('request-notification-btn');
  if (reqNotifBtn) {
    reqNotifBtn.addEventListener('click', async () => {
      await requestNotificationPermission();
      renderSettingsNotifications();
    });
  }

  // #514: a country opens the region picker; a region switches the holidays on, "none" off.
  const saveHolidayRegion = region => changeHolidayRegion(region)
    .catch(err => showToast('Die Feiertage konnten nicht gespeichert werden: ' + err.message, 'error'))
    .then(() => renderSettingsHolidays());
  $('holiday-country').addEventListener('change', e => {
    if (!e.target.value) {
      saveHolidayRegion(null);
      return;
    }
    const country = holidayCountries.find(c => c.code === e.target.value);
    $('holiday-region-group').classList.remove('hidden');
    $('holiday-region').innerHTML = '<option value="" disabled selected>Region wählen</option>' + country.regions
      .map(r => `<option value="${escHtml(r.code)}">${escHtml(r.name)}</option>`).join('');
    $('holiday-region').focus();
  });
  $('holiday-region').addEventListener('change', e => saveHolidayRegion(e.target.value));

  // #509: second time zone — the checkbox opens the search, a hit switches the column on.
  $('show-secondary-tz-toggle').addEventListener('change', e => {
    if (e.target.checked) {
      $('secondary-tz-picker').classList.remove('hidden');
      $('secondary-tz-search').focus();
    } else if (store.get('secondaryTimezone')) {
      changeSecondaryTimezone(null).catch(err => {
        showToast('Die Zeitzone konnte nicht gespeichert werden: ' + err.message, 'error');
        renderSettingsTimezone();
      });
    } else {
      renderSettingsTimezone();
    }
  });
  $('secondary-tz-search').addEventListener('input', e => renderSecondaryTimezoneResults(e.target.value));
  $('secondary-tz-results').addEventListener('click', e => {
    const hit = e.target.closest('button[data-tz]');
    if (!hit) return;
    changeSecondaryTimezone(hit.dataset.tz).catch(err => {
      showToast('Die Zeitzone konnte nicht gespeichert werden: ' + err.message, 'error');
    });
  });

  if (window.WorkingHoursModule) {
    window.WorkingHoursModule.init();
  }

  // Mobile sidebar toggle with inert management
  function syncSidebarInert() {
    const sidebar = $('sidebar');
    if (!sidebar) return;
    if (window.innerWidth <= 768 && !sidebar.classList.contains('open')) {
      sidebar.setAttribute('inert', '');
    } else {
      sidebar.removeAttribute('inert');
    }
  }
  $('menu-btn').addEventListener('click', () => {
    const sidebar = $('sidebar');
    if (sidebar) {
      sidebar.classList.add('open');
      sidebar.removeAttribute('inert');
    }
  });
  $('sidebar-toggle').addEventListener('click', () => {
    const sidebar = $('sidebar');
    if (sidebar) {
      sidebar.classList.remove('open');
      if (window.innerWidth <= 768) {
        sidebar.setAttribute('inert', '');
      }
    }
  });
  syncSidebarInert();
  window.addEventListener('resize', syncSidebarInert);

  // Search (inline in toolbar, no toggle needed)
  $('search-input').addEventListener('input', e => {
    store.set({ searchQuery: e.target.value });
    renderCalendarView();
  });

  // Close popover on outside click
  document.addEventListener('click', e => {
    if (_popoverUid && !e.target.closest('.event-popover') && !e.target.closest('[data-event-uid]')) {
      // A click that focused another control keeps that focus; only a click on nothing returns it to the chip.
      const active = document.activeElement;
      closePopover({ restoreFocus: !active || active === document.body || $('event-popover').contains(active) });
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
    if (e.origin !== window.location.origin) return;
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

  // Holding Alt shows the key-hint layer (design guide); see [data-key-hint] in app.css.
  const setKeyHints = visible => document.documentElement.classList.toggle('key-hints-visible', visible);
  document.addEventListener('keyup', e => {
    if (e.key === 'Alt') setKeyHints(false);
  });
  window.addEventListener('blur', () => setKeyHints(false));

  document.addEventListener('keydown', e => {
    if (e.key === 'Alt') {
      if (!e.repeat) setKeyHints(true);
      return;
    }

    const isModalOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
      .some(m => !m.classList.contains('hidden')) || !$('event-popover').classList.contains('hidden');

    const targetEl = e.target;
    const tagName = (targetEl.tagName || '').toUpperCase();
    const role = typeof targetEl.getAttribute === 'function' ? (targetEl.getAttribute('role') || '').toLowerCase() : '';
    const isEditable = Boolean(targetEl.isContentEditable) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName);
    // Anything focused other than the page itself owns the arrow keys (#126).
    const isInteractive = targetEl !== document.body && targetEl !== document.documentElement && targetEl !== document;

    const eventPayload = {
      key: e.key,
      code: e.code,
      targetTagName: tagName,
      targetRole: role,
      isTargetEditable: isEditable,
      isTargetInteractive: isInteractive,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    };

    const action = typeof Shortcuts !== 'undefined'
      ? Shortcuts.parseShortcutAction(eventPayload, isModalOpen)
      : null;

    if (!action) return;
    if (e.altKey) {
      // Keep Alt+letter away from browser menus and accesskeys.
      e.preventDefault();
      setKeyHints(false);
    }

    switch (action) {
      case 'CLOSE_MODAL':
        if (!handleEscapeKey(e)) {
          closePopover();
          document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => closeDialog(m));
          document.querySelectorAll('.popover').forEach(p => p.remove());
        }
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
        openCreateModal(store.get('currentDate') || new Date(), EVENT_MODAL_CALLBACKS);
        break;

      case 'FOCUS_SEARCH': {
        e.preventDefault();
        const searchInput = $('search-input');
        if (searchInput) searchInput.focus();
        break;
      }

      case 'TOGGLE_HELP': {
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
    }
  });

  // Auto-refresh every 5 minutes
  setInterval(loadEvents, 5 * 60 * 1000);
}

// ── Toast Notifications ───────────────────────────────────────────────────────

export function showToast(message, type = 'info', { action, duration = 4000 } = {}) {
  const container = $('toast-container');
  if (!container) return;
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;

  if (type === 'error') {
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    setStatus('Fehler: ' + message);
  }

  const icons = {
    success: '<polyline points="20 6 9 17 4 12"></polyline>',
    error: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
    warning: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'
  };
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[type] || icons.info}</svg>
    <span class="toast-msg">${escHtml(message)}</span>
    ${action ? `<button type="button" class="toast-action">${escHtml(action.label)}</button>` : ''}
    <button type="button" class="toast-close" aria-label="Meldung schließen">×</button>`;

  container.appendChild(toast);
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  toast.querySelector('.toast-action')?.addEventListener('click', () => {
    toast.remove();
    action.onClick();
  });

  // Error toasts persist until closed; success/info toasts auto-dismiss (after 4 seconds by default)
  if (type !== 'error') {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// #348: every delete moves the item to the trash; for 8 s its toast offers "Rückgängig".
export function showUndoToast(message, trashId) {
  showToast(message, 'info', {
    duration: 8000,
    action: { label: 'Rückgängig', onClick: () => restoreFromTrash(trashId) }
  });
}

async function restoreFromTrash(trashId) {
  let restored;
  try {
    restored = await TrashAPI.restore(trashId);
  } catch (err) {
    showToast('Wiederherstellen fehlgeschlagen: ' + err.message, 'error');
    return false;
  }
  showToast('Wiederhergestellt.', 'success');
  if (restored.kind === 'calendar') await loadCalendars();
  invalidateEventCache();
  await loadEvents();
  await loadTasks();
  renderSidebar();
  renderCalendarView();
  renderSettingsCalendars();
  return true;
}

const TRASH_NOUNS = { event: 'Termin', task: 'Aufgabe', calendar: 'Kalender' };
// A collection that holds only tasks is a task list.
const trashNoun = (item) => (item.kind === 'calendar' && !item.components.includes('VEVENT')) ? 'Aufgabenliste' : TRASH_NOUNS[item.kind];

async function renderSettingsTrash() {
  const list = $('settings-trash-list');
  if (!list) return;
  let items;
  try {
    ({ items } = await TrashAPI.list());
  } catch (err) {
    list.innerHTML = `<div class="trash-hint">Papierkorb konnte nicht geladen werden: ${escHtml(err.message)}</div>`;
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="trash-hint">Der Papierkorb ist leer.</div>';
    return;
  }
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  list.innerHTML = items.map(item => `
      <div class="settings-item trash-item" data-trash-id="${escHtml(item.id)}">
        <div class="settings-item-info">
          <div class="settings-item-name">${escHtml(item.title)}</div>
          <div class="trash-hint">${trashNoun(item)}${item.kind === 'calendar' ? ` · ${item.itemCount} Einträge` : ''} · ${item.deletedAtProvider ? 'beim Anbieter gelöscht' : 'gelöscht'} ${escHtml(day.format(new Date(item.deletedAt)))} · endgültig weg ${escHtml(day.format(new Date(item.purgeAt)))}</div>
        </div>
        <div class="settings-item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-trash-restore="${escHtml(item.id)}">Wiederherstellen</button>
          <button type="button" class="btn btn-danger btn-sm" data-trash-purge="${escHtml(item.id)}">Endgültig löschen</button>
        </div>
      </div>`).join('');

  list.querySelectorAll('[data-trash-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = items.find(i => i.id === btn.dataset.trashRestore);
      // #597: an item the provider deleted is created there again by the next sync.
      const where = item.deletedAtProvider ? 'wurde beim Anbieter gelöscht und wird dort' : 'wird beim verknüpften Anbieter';
      if (item.linked && !(await confirmDialog(
        `„${item.title}“ ${where} neu angelegt. Die UID kann sich dabei ändern, und Gäste bekommen eventuell eine neue Einladung. Wiederherstellen?`,
        'Wiederherstellen'))) return;
      if (await restoreFromTrash(item.id)) await renderSettingsTrash();
    });
  });
  list.querySelectorAll('[data-trash-purge]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = items.find(i => i.id === btn.dataset.trashPurge);
      if (!(await confirmDialog(`„${item.title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`))) return;
      try {
        await TrashAPI.purge(item.id);
      } catch (err) {
        showToast(err.message, 'error');
        return;
      }
      await renderSettingsTrash();
    });
  });
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

// Issue #203 / #198: the background sync worker records failures as an ERROR
// job with an error_message. Surface the latest finished job's failure; a
// newer successful run supersedes an older error, queued/running jobs do not.
let dismissedSyncErrorId = null;

export async function checkSyncStatus() {
  const banner = $('sync-error-banner');
  const textEl = $('sync-error-text');
  let jobs;
  try {
    ({ jobs } = await AccountsAPI.getSyncStatus());
    if (!Array.isArray(jobs)) throw new Error('unerwartete Antwort');
  } catch (err) {
    // Polled every minute — report in the banner rather than stacking toasts.
    textEl.textContent = 'Sync-Status konnte nicht geladen werden: ' + err.message;
    $('sync-progress').classList.add('hidden');
    delete banner.dataset.jobId;
    banner.classList.remove('hidden');
    return;
  }
  renderSyncProgress(jobs);
  store.set({ syncJobs: jobs });
  renderSettingsAccounts();
  // Server orders by created_at DESC.
  const latest = jobs.find(j => j.status === 'SUCCESS' || j.status === 'ERROR');
  if (latest && latest.status === 'ERROR' && latest.id !== dismissedSyncErrorId) {
    textEl.textContent =
      'Hintergrund-Synchronisation fehlgeschlagen: ' + (latest.errorMessage || 'unbekannter Fehler');
    banner.dataset.jobId = latest.id;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function dismissSyncError() {
  const banner = $('sync-error-banner');
  dismissedSyncErrorId = banner.dataset.jobId || null;
  banner.classList.add('hidden');
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot().catch(console.error);
