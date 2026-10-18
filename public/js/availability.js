/**
 * availability.js — Frontend Availability Slots Booking Manager
 */

import { AvailabilityAPI, CalendarsAPI } from './api.js';
import { showToast } from './app.js';
import { holdsEvents } from './calendarLabels.js';
import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';

// #503: weekly hours are indexed like Date#getUTCDay (0 = Sunday); the dialog lists Monday first.
const WEEKDAYS = [
  { day: 1, name: 'Montag', short: 'Mo' }, { day: 2, name: 'Dienstag', short: 'Di' },
  { day: 3, name: 'Mittwoch', short: 'Mi' }, { day: 4, name: 'Donnerstag', short: 'Do' },
  { day: 5, name: 'Freitag', short: 'Fr' }, { day: 6, name: 'Samstag', short: 'Sa' },
  { day: 0, name: 'Sonntag', short: 'So' }
];
const DEFAULT_WINDOW = { start: '09:00', end: '17:00' };
// A new page is open Monday to Friday 09:00–17:00, as on the server.
const DEFAULT_WEEKLY_HOURS = [0, 1, 2, 3, 4, 5, 6].map(d => (d >= 1 && d <= 5 ? [DEFAULT_WINDOW] : []));

export function initAvailabilityManager() {
  const btn = document.getElementById('availability-btn');
  const backdrop = document.getElementById('availability-modal-backdrop');
  const closeBtn = document.getElementById('availability-modal-close');
  const form = document.getElementById('availability-form');
  const calSelect = document.getElementById('ap-calendar');
  const busyList = document.getElementById('ap-busy-calendars');
  const pagesList = document.getElementById('availability-pages-list');
  const weekdaysEl = document.getElementById('ap-weekdays');

  if (!btn || !backdrop) return;

  renderWeekdays(DEFAULT_WEEKLY_HOURS);

  let calendarNames = new Map();

  btn.addEventListener('click', async () => {
    openDialog(backdrop);
    await loadCalendars();
    await loadPages();
  });

  closeBtn?.addEventListener('click', () => {
    closeDialog(backdrop);
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeDialog(backdrop);
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const title = document.getElementById('ap-title').value;
      const slug = document.getElementById('ap-slug').value;
      const calendarId = calSelect.value;
      const durationMinutes = parseInt(document.getElementById('ap-duration').value, 10) || 30;
      const maxPerDay = document.getElementById('ap-max-per-day').value;
      const busyCalendarIds = [...busyList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);

      await AvailabilityAPI.createPage({
        title,
        slug,
        calendarId,
        durationMinutes,
        weeklyHours: readWeekdays(),
        bufferMinutes: Number(document.getElementById('ap-buffer').value),
        maxBookingsPerDay: maxPerDay === '' ? null : Number(maxPerDay),
        minNoticeMinutes: Number(document.getElementById('ap-min-notice').value) * 60,
        busyCalendarIds
      });

      showToast('Buchbare Zeiten veröffentlicht', 'success');
      form.reset();
      renderWeekdays(DEFAULT_WEEKLY_HOURS);
      await loadCalendars();
      await loadPages();
    } catch (err) {
      showToast(err.message || 'Fehler beim Veröffentlichen der buchbaren Zeiten', 'error');
    }
  });

  function windowRow(name, win) {
    return `
      <span class="ap-window" style="display: inline-flex; gap: 4px; align-items: center;">
        <input class="form-input ap-window-start" type="time" value="${win.start}" aria-label="${name} von" style="width: auto;" />
        –
        <input class="form-input ap-window-end" type="time" value="${win.end}" aria-label="${name} bis" style="width: auto;" />
        <button type="button" class="btn btn-ghost btn-sm ap-window-remove" aria-label="Zeitfenster am ${name} entfernen">×</button>
      </span>`;
  }

  // One row per weekday: a switch and that day's windows, shown only while the day is on.
  function renderWeekdays(weeklyHours) {
    weekdaysEl.innerHTML = WEEKDAYS.map(({ day, name }) => {
      const windows = weeklyHours[day];
      return `
        <div class="ap-day" data-day="${day}" style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; font-size: 13px;">
          <label style="display: flex; gap: 6px; align-items: center; min-width: 110px; padding-top: 6px;">
            <input type="checkbox" class="ap-day-toggle" ${windows.length ? 'checked' : ''} />
            ${name}
          </label>
          <div class="ap-day-windows" ${windows.length ? '' : 'hidden'}>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
              ${(windows.length ? windows : [DEFAULT_WINDOW]).map(win => windowRow(name, win)).join('')}
              <button type="button" class="btn btn-ghost btn-sm ap-window-add" aria-label="Zeitfenster am ${name} hinzufügen">+ Zeitfenster</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  weekdaysEl?.addEventListener('change', (e) => {
    if (!e.target.classList.contains('ap-day-toggle')) return;
    const dayEl = e.target.closest('.ap-day');
    const windowsEl = dayEl.querySelector('.ap-day-windows');
    windowsEl.hidden = !e.target.checked;
    // A day switched on gets the default window back if all of its windows were removed.
    if (e.target.checked && !windowsEl.querySelector('.ap-window')) {
      const { name } = WEEKDAYS.find(w => w.day === Number(dayEl.dataset.day));
      windowsEl.querySelector('.ap-window-add').insertAdjacentHTML('beforebegin', windowRow(name, DEFAULT_WINDOW));
    }
  });

  weekdaysEl?.addEventListener('click', (e) => {
    const dayEl = e.target.closest('.ap-day');
    if (!dayEl) return;
    const { name } = WEEKDAYS.find(w => w.day === Number(dayEl.dataset.day));
    if (e.target.classList.contains('ap-window-add')) {
      e.target.insertAdjacentHTML('beforebegin', windowRow(name, DEFAULT_WINDOW));
      e.target.previousElementSibling.querySelector('.ap-window-start').focus();
    } else if (e.target.classList.contains('ap-window-remove')) {
      const addBtn = dayEl.querySelector('.ap-window-add');
      e.target.closest('.ap-window').remove();
      addBtn.focus();
      // Without a window the day is off.
      if (!dayEl.querySelector('.ap-window')) {
        dayEl.querySelector('.ap-day-toggle').checked = false;
        dayEl.querySelector('.ap-day-windows').hidden = true;
        dayEl.querySelector('.ap-day-toggle').focus();
      }
    }
  });

  function readWeekdays() {
    const week = [[], [], [], [], [], [], []];
    for (const dayEl of weekdaysEl.querySelectorAll('.ap-day')) {
      if (!dayEl.querySelector('.ap-day-toggle').checked) continue;
      week[Number(dayEl.dataset.day)] = [...dayEl.querySelectorAll('.ap-window')].map(win => ({
        start: win.querySelector('.ap-window-start').value,
        end: win.querySelector('.ap-window-end').value
      }));
    }
    return week;
  }

  async function loadCalendars() {
    let list;
    try {
      const res = await CalendarsAPI.list();
      // #500: bookings are events; a task list cannot take them or block a slot.
      list = (Array.isArray(res) ? res : (res?.calendars || [])).filter(holdsEvents);
    } catch (err) {
      calSelect.innerHTML = '';
      busyList.innerHTML = '';
      showToast(err.message || 'Kalender konnten nicht geladen werden', 'error');
      return;
    }
    calendarNames = new Map(list.map(c => [c.id, c.displayName || c.name || c.id]));
    calSelect.innerHTML = list.map(c => `
      <option value="${escapeHtml(c.id)}">${escapeHtml(c.displayName || c.name || c.id)}</option>
    `).join('');
    busyList.innerHTML = list.map(c => `
      <label class="ap-busy-calendar" style="display: flex; gap: 6px; align-items: center; font-size: 13px;">
        <input type="checkbox" value="${escapeHtml(c.id)}" />
        ${escapeHtml(c.displayName || c.name || c.id)}
      </label>
    `).join('');
    syncBusyTarget();
  }

  // The target calendar always counts as busy; its checkbox shows that and cannot be cleared.
  // A box that stops being the target gets back the owner's own choice.
  function syncBusyTarget() {
    for (const cb of busyList.querySelectorAll('input[type="checkbox"]')) {
      const isTarget = cb.value === calSelect.value;
      if (isTarget && !cb.disabled) {
        cb.dataset.ownerChoice = cb.checked ? 'checked' : '';
        cb.checked = true;
      } else if (!isTarget && cb.disabled) {
        cb.checked = cb.dataset.ownerChoice === 'checked';
      }
      cb.disabled = isTarget;
    }
  }
  calSelect?.addEventListener('change', syncBusyTarget);

  async function loadPages() {
    if (!pagesList) return;
    try {
      const pages = await AvailabilityAPI.getPages();
      if (!pages || pages.length === 0) {
        pagesList.innerHTML = '<p class="empty-state">Noch keine buchbaren Zeiten veröffentlicht.</p>';
        return;
      }

      pagesList.innerHTML = pages.map(p => {
        const publicUrl = `${window.location.origin}/public/booking/?slug=${encodeURIComponent(p.slug)}`;
        const busyNames = [p.calendarId, ...(p.busyCalendarIds || [])].map(id => calendarNames.get(id) || id);
        return `
          <div class="availability-page-card" style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="font-size: 14px;">${escapeHtml(p.title)}</strong>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Dauer: ${p.durationMinutes} Min. | Slug: <code>${escapeHtml(p.slug)}</code>
              </div>
              <div class="availability-page-hours" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                ${escapeHtml(describeHours(p))}
              </div>
              <div class="availability-page-busy" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Belegt aus: ${busyNames.map(escapeHtml).join(', ')}
              </div>
              <div style="margin-top: 4px;">
                <a href="${publicUrl}" target="_blank" style="font-size: 12px; color: var(--accent); text-decoration: underline;">${publicUrl}</a>
              </div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button class="btn btn-ghost btn-sm copy-link-btn" data-url="${escapeHtml(publicUrl)}">Link kopieren</button>
              <button class="btn btn-danger btn-sm delete-page-btn" data-id="${escapeHtml(p.id)}">Löschen</button>
            </div>
          </div>
        `;
      }).join('');

      pagesList.querySelectorAll('.copy-link-btn').forEach(b => {
        b.addEventListener('click', () => {
          const url = b.getAttribute('data-url');
          navigator.clipboard.writeText(url);
          showToast('Link in Zwischenablage kopiert', 'success');
        });
      });

      pagesList.querySelectorAll('.delete-page-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-id');
          if (await confirmDialog('Möchtest du diese buchbaren Zeiten wirklich löschen?')) {
            try {
              await AvailabilityAPI.deletePage(id);
              showToast('Buchbare Zeiten gelöscht', 'success');
              await loadPages();
            } catch (err) {
              showToast(err.message || 'Fehler beim Löschen', 'error');
            }
          }
        });
      });
    } catch (err) {
      console.error('[availability] Error loading pages:', err);
      pagesList.innerHTML = '<p class="empty-state">Fehler beim Laden der buchbaren Zeiten.</p>';
    }
  }

  function describeHours(p) {
    const days = WEEKDAYS.filter(({ day }) => p.weeklyHours[day].length)
      .map(({ day, short }) => `${short} ${p.weeklyHours[day].map(w => `${w.start}–${w.end}`).join(', ')}`);
    const limits = [];
    if (p.bufferMinutes) limits.push(`Puffer ${p.bufferMinutes} Min.`);
    if (p.maxBookingsPerDay !== null) limits.push(`höchstens ${p.maxBookingsPerDay} pro Tag`);
    if (p.minNoticeMinutes) limits.push(`Vorlauf ${p.minNoticeMinutes / 60} Std.`);
    return [days.join(' · '), ...limits].join(' | ');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
  }
}
