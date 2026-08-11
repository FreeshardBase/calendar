/**
 * invitations.js — iTIP / RSVP Invitations inbox component
 */

import { InvitationsAPI } from './api.js';

let invitationsList = [];

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
    updateBadge();
  } catch (err) {
    console.error('[invitations] Failed to load:', err);
  }
}

function updateBadge() {
  const badge = document.getElementById('invitations-badge');
  if (!badge) return;

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
  if (backdrop) backdrop.classList.remove('hidden');
  renderInvitationsList();
}

export function closeInvitationsModal() {
  const backdrop = document.getElementById('invitations-modal-backdrop');
  if (backdrop) backdrop.classList.add('hidden');
}

function renderInvitationsList() {
  const container = document.getElementById('invitations-list-body');
  if (!container) return;

  if (invitationsList.length === 0) {
    container.innerHTML = '<p class="empty-state" style="padding: 20px; text-align: center; color: var(--text-muted);">Keine ausstehenden Einladungen vorhanden.</p>';
    return;
  }

  container.innerHTML = invitationsList.map(inv => {
    const attendeesHtml = (inv.attendees || []).map(att => {
      const statusLabel = {
        'ACCEPTED': '<span class="status-badge status-accepted">Zugesagt</span>',
        'DECLINED': '<span class="status-badge status-declined">Abgesagt</span>',
        'TENTATIVE': '<span class="status-badge status-tentative">Vorläufig</span>',
        'NEEDS-ACTION': '<span class="status-badge status-pending">Offen</span>'
      }[att.status] || '<span class="status-badge">Offen</span>';
      return `<div class="inv-attendee-row">
        <span>${att.name || att.email}</span>
        ${statusLabel}
      </div>`;
    }).join('');

    const formattedDate = inv.start ? new Date(inv.start).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';

    return `
      <div class="invitation-card" data-uid="${inv.uid}">
        <div class="invitation-header">
          <strong class="invitation-title">${inv.title || 'Unbenannter Termin'}</strong>
          <span class="invitation-date">${formattedDate}</span>
        </div>
        ${inv.organizer ? `<div class="invitation-organizer">Organisator: ${inv.organizer.name || inv.organizer.email}</div>` : ''}
        ${inv.description ? `<div class="invitation-desc">${inv.description}</div>` : ''}
        <div class="invitation-attendees">
          <small>Teilnehmer:</small>
          ${attendeesHtml}
        </div>
        <div class="invitation-actions">
          <button class="btn btn-sm btn-success rsvp-btn" data-status="ACCEPTED" data-uid="${inv.uid}" data-href="${inv.href || ''}" data-calid="${inv.calendarId || ''}">Zusagen</button>
          <button class="btn btn-sm btn-secondary rsvp-btn" data-status="TENTATIVE" data-uid="${inv.uid}" data-href="${inv.href || ''}" data-calid="${inv.calendarId || ''}">Vorläufig</button>
          <button class="btn btn-sm btn-danger rsvp-btn" data-status="DECLINED" data-uid="${inv.uid}" data-href="${inv.href || ''}" data-calid="${inv.calendarId || ''}">Absagen</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.rsvp-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const status = e.currentTarget.dataset.status;
      const uid = e.currentTarget.dataset.uid;
      const href = e.currentTarget.dataset.href;
      const calendarId = e.currentTarget.dataset.calid;

      const email = 'testuser@example.com';

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
