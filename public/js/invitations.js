/**
 * invitations.js — iTIP / RSVP Invitations inbox component
 */

import { InvitationsAPI } from './api.js';
import { openDialog, closeDialog } from './dialogFocus.js';
import { showToast } from './app.js';
import { formatDate } from './locale.js';
import { t } from './i18n.js';

function notifyToast(message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

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

  // The badge title and an open inbox are rendered here; they follow a language switch.
  window.addEventListener('ui-language-changed', () => {
    updateBadge();
    if (modalBackdrop && !modalBackdrop.classList.contains('hidden')) renderInvitationsList();
  });

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
    badge.title = t('modules.invitations.badgeError');
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
    return `<p class="empty-state invitations-error-state" style="color: var(--danger);">${escHtml(t('modules.invitations.loadError'))}</p>`;
  }

  if (!Array.isArray(invList) || invList.length === 0) {
    return `<p class="empty-state">${escHtml(t('modules.invitations.empty'))}</p>`;
  }

  return invList.map(inv => {
    const attendeesHtml = (inv.attendees || []).map(att => {
      const statusLabel = {
        'ACCEPTED': `<span class="status-badge status-accepted">${escHtml(t('modules.invitations.status.accepted'))}</span>`,
        'DECLINED': `<span class="status-badge status-declined">${escHtml(t('modules.invitations.status.declined'))}</span>`,
        'TENTATIVE': `<span class="status-badge status-tentative">${escHtml(t('modules.invitations.status.tentative'))}</span>`,
        'NEEDS-ACTION': `<span class="status-badge status-pending">${escHtml(t('modules.invitations.status.open'))}</span>`
      }[att.status] || `<span class="status-badge">${escHtml(t('modules.invitations.status.open'))}</span>`;
      return `<div class="inv-attendee-row">
        <span>${escHtml(att.name || att.email)}</span>
        ${statusLabel}
      </div>`;
    }).join('');

    const formattedDate = inv.start ? formatDate(inv.start, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    return `
      <div class="invitation-card" data-uid="${escHtml(inv.uid)}">
        <div class="invitation-header">
          <strong class="invitation-title">${escHtml(inv.title || t('modules.invitations.untitled'))}</strong>
          <span class="invitation-date">${escHtml(formattedDate)}</span>
        </div>
        ${inv.organizer ? `<div class="invitation-organizer">${escHtml(t('modules.invitations.organizer', { name: inv.organizer.name || inv.organizer.email }))}</div>` : ''}
        ${inv.description ? `<div class="invitation-desc">${escHtml(inv.description)}</div>` : ''}
        <div class="invitation-attendees">
          <small>${escHtml(t('modules.invitations.attendees'))}</small>
          ${attendeesHtml}
        </div>
        <div class="invitation-actions">
          <button class="btn btn-sm btn-success rsvp-btn" data-status="ACCEPTED" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">${escHtml(t('modules.invitations.accept'))}</button>
          <button class="btn btn-sm btn-secondary rsvp-btn" data-status="TENTATIVE" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">${escHtml(t('modules.invitations.tentative'))}</button>
          <button class="btn btn-sm btn-danger rsvp-btn" data-status="DECLINED" data-uid="${escHtml(inv.uid)}" data-href="${escHtml(inv.href || '')}" data-calid="${escHtml(inv.calendarId || '')}" data-email="${escHtml(inv.userEmail || '')}">${escHtml(t('modules.invitations.decline'))}</button>
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
        notifyToast(t('modules.invitations.toast.rsvpFailed', { message: err.message }), 'error');
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
    renderInvitationsHTML,
    renderInvitationsList
  };
}

