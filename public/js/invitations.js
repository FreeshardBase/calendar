/**
 * invitations.js — iTIP / RSVP Invitations inbox component
 */

import { InvitationsAPI } from './api.js';
import { openDialog, closeDialog } from './dialogFocus.js';

let invitationsList = [];
let invitationsError = false;

export function initInvitations() {
  const btn = document.getElementById('invitations-btn');
  const modalBackdrop = document.getElementById('invitations-modal-backdrop');
  const closeBtn = document.getElementById('invitations-modal-close');

  if (btn) {
    btn.addEventListener('click', () => {
      openInvitationsModal();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeInvitationsModal();
    });
  }

  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) closeInvitationsModal();
    });
  }

  loadInvitations();
}

export async function loadInvitations() {
  try {
    const data = await InvitationsAPI.list();
    invitationsList = Array.isArray(data) ? data : [];
    invitationsError = false;
    updateBadge();
  } catch (err) {
    console.error('[invitations] Failed to load:', err);
    invitationsError = true;
    updateBadge();
  }
}

function updateBadge() {
  const badge = document.getElementById('invitations-badge');
  if (!badge) return;

  if (invitationsError) {
    badge.textContent = '!';
    if (badge.classList && typeof badge.classList.add === 'function') {
      badge.classList.add('badge-error');
    }
    badge.style.display = 'inline-flex';
    badge.title = 'Fehler beim Laden der Einladungen';
    return;
  } else if (badge.classList && typeof badge.classList.remove === 'function') {
    badge.classList.remove('badge-error');
    if (typeof badge.removeAttribute === 'function') {
      badge.removeAttribute('title');
    }
  }

  const count = invitationsList.length;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

export function openInvitationsModal() {
  const backdrop = document.getElementById('invitations-modal-backdrop');
  if (backdrop) openDialog(backdrop);
  renderInvitationsList();
}

export function closeInvitationsModal() {
  const backdrop = document.getElementById('invitations-modal-backdrop');
  if (backdrop) closeDialog(backdrop);
}

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInvitationsHTML(invList, options = {}) {
  if (options.error || invitationsError) {
    return '<p class="empty-state invitations-error-state" style="padding: 20px; text-align: center; color: var(--danger);">Fehler beim Laden der Einladungen.</p>';
  }

  if (!Array.isArray(invList) || invList.length === 0) {
    return '<p class="empty-state" style="padding: 20px; text-align: center; color: var(--text-muted);">Keine ausstehenden Einladungen vorhanden.</p>';
  }

  return invList.map(inv => {
    const attendeesHtml = (inv.attendees || []).map(att => {
      const statusLabel = {
        'ACCEPTED': '<span class="status-badge status-accepted">Zugesagt</span>',
        'DECLINED': '<span class="status-badge status-declined">Abgesagt</span>',
        'TENTATIVE': '<span class="status-badge status-tentative">Vorläufig</span>',
        'NEEDS-ACTION': '<span class="status-badge status-pending">Offen</span>'
      }[att.status] || '<span class="status-badge">Offen</span>';
      return `<div class="inv-attendee-row">
        <span>${escHtml(att.name || att.email)}</span>
        ${statusLabel}
      </div>`;
    }).join('');

    const formattedDate = inv.start ? new Date(inv.start).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';

    return `
      <div class="invitation-card" data-uid="${escHtml(inv.uid)}">
        <div class="invitation-header">
          <strong class="invitation-title">${escHtml(inv.title || 'Unbenannter Termin')}</strong>
          <span class="invitation-date">${escHtml(formattedDate)}</span>
        </div>
        ${inv.organizer ? `<div class="invitation-organizer">Organisator*in: ${escHtml(inv.organizer.name || inv.organizer.email)}</div>` : ''}
        ${inv.description ? `<div class="invitation-desc">${escHtml(inv.description)}</div>` : ''}
        <div class="invitation-attendees">
          <small>Teilnehmende:</small>
          ${attendeesHtml}
        </div>
        <div class="invitation-actions">
          <button class="btn btn-sm btn-success rsvp-btn" data-status="ACCEPTED" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">Zusagen</button>
          <button class="btn btn-sm btn-secondary rsvp-btn" data-status="TENTATIVE" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">Vorläufig</button>
          <button class="btn btn-sm btn-danger rsvp-btn" data-status="DECLINED" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">Absagen</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderInvitationsList() {
  const container = document.getElementById('invitations-list-body');
  if (!container) return;

  container.innerHTML = renderInvitationsHTML(invitationsList);

  container.querySelectorAll('.rsvp-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const status = e.currentTarget.dataset.status;
      const uid = e.currentTarget.dataset.uid;
      const href = e.currentTarget.dataset.href;
      const calendarId = e.currentTarget.dataset.calid;
      const email = e.currentTarget.dataset.email || undefined;

      try {
        await InvitationsAPI.rsvp(uid, { calendarId, href, email, status });
        await loadInvitations();
        renderInvitationsList();
      } catch (err) {
        console.error('[invitations] RSVP error:', err);
        alert('RSVP konnte nicht gespeichert werden: ' + err.message);
      }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initInvitations,
    loadInvitations,
    openInvitationsModal,
    closeInvitationsModal,
    escHtml,
    renderInvitationsHTML
  };
}

