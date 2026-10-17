/**
 * availability.js — Frontend Availability Slots Booking Manager
 */

import { AvailabilityAPI, CalendarsAPI } from './api.js';
import { showToast } from './app.js';
import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';

export function initAvailabilityManager() {
  const btn = document.getElementById('availability-btn');
  const backdrop = document.getElementById('availability-modal-backdrop');
  const closeBtn = document.getElementById('availability-modal-close');
  const form = document.getElementById('availability-form');
  const calSelect = document.getElementById('ap-calendar');
  const busyList = document.getElementById('ap-busy-calendars');
  const pagesList = document.getElementById('availability-pages-list');

  if (!btn || !backdrop) return;

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
      const startHour = parseInt(document.getElementById('ap-start-hour').value, 10) || 9;
      const endHour = parseInt(document.getElementById('ap-end-hour').value, 10) || 17;
      const busyCalendarIds = [...busyList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);

      await AvailabilityAPI.createPage({
        title,
        slug,
        calendarId,
        durationMinutes,
        startHour,
        endHour,
        daysOfWeek: '1,2,3,4,5',
        busyCalendarIds
      });

      showToast('Buchungsseite erfolgreich erstellt', 'success');
      form.reset();
      await loadCalendars();
      await loadPages();
    } catch (err) {
      showToast(err.message || 'Fehler beim Erstellen der Buchungsseite', 'error');
    }
  });

  async function loadCalendars() {
    let list;
    try {
      const res = await CalendarsAPI.list();
      list = Array.isArray(res) ? res : (res?.calendars || []);
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
        pagesList.innerHTML = '<p class="empty-state">Noch keine Buchungsseiten vorhanden.</p>';
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
                Dauer: ${p.durationMinutes} Min. | Zeitfenster: ${p.startHour}:00 - ${p.endHour}:00 | Slug: <code>${escapeHtml(p.slug)}</code>
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
          if (await confirmDialog('Möchtest du diese Buchungsseite wirklich löschen?')) {
            try {
              await AvailabilityAPI.deletePage(id);
              showToast('Buchungsseite gelöscht', 'success');
              await loadPages();
            } catch (err) {
              showToast(err.message || 'Fehler beim Löschen', 'error');
            }
          }
        });
      });
    } catch (err) {
      console.error('[availability] Error loading pages:', err);
      pagesList.innerHTML = '<p class="empty-state">Fehler beim Laden der Buchungsseiten.</p>';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
  }
}
