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
  const pagesList = document.getElementById('availability-pages-list');

  if (!btn || !backdrop) return;

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

      await AvailabilityAPI.createPage({
        title,
        slug,
        calendarId,
        durationMinutes,
        startHour,
        endHour,
        daysOfWeek: '1,2,3,4,5'
      });

      showToast('Buchungsseite erfolgreich erstellt', 'success');
      form.reset();
      await loadPages();
    } catch (err) {
      showToast(err.message || 'Fehler beim Erstellen der Buchungsseite', 'error');
    }
  });

  async function loadCalendars() {
    if (!calSelect) return;
    try {
      const res = await CalendarsAPI.list();
      const list = Array.isArray(res) ? res : (res?.calendars || []);
      if (list.length === 0) {
        calSelect.innerHTML = '<option value="default-local">Standard Kalender</option>';
        return;
      }
      calSelect.innerHTML = list.map(c => `
        <option value="${c.id}">${c.displayName || c.name || c.id}</option>
      `).join('');
    } catch (err) {
      console.error('[availability] Error loading calendars:', err);
      calSelect.innerHTML = '<option value="default-local">Standard Kalender</option>';
    }
  }

  async function loadPages() {
    if (!pagesList) return;
    try {
      const pages = await AvailabilityAPI.getPages();
      if (!pages || pages.length === 0) {
        pagesList.innerHTML = '<p class="empty-state">Noch keine Buchungsseiten vorhanden.</p>';
        return;
      }

      pagesList.innerHTML = pages.map(p => {
        const publicUrl = `${window.location.origin}/booking.html?slug=${encodeURIComponent(p.slug)}`;
        return `
          <div class="availability-page-card" style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="font-size: 14px;">${escapeHtml(p.title)}</strong>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Dauer: ${p.durationMinutes} Min. | Zeitfenster: ${p.startHour}:00 - ${p.endHour}:00 | Slug: <code>${escapeHtml(p.slug)}</code>
              </div>
              <div style="margin-top: 4px;">
                <a href="${publicUrl}" target="_blank" style="font-size: 12px; color: var(--accent); text-decoration: underline;">${publicUrl}</a>
              </div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button class="btn btn-ghost btn-sm copy-link-btn" data-url="${publicUrl}">Link kopieren</button>
              <button class="btn btn-danger btn-sm delete-page-btn" data-id="${p.id}">Löschen</button>
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
