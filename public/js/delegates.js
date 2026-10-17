'use strict';

/**
 * FreeShard WebCalendar — Delegate Permissions & Executive Assistant Management Frontend Engine
 */
// The error message of a failed response: the JSON `error` field, or the status when the body is not
// JSON. Only that parse error is handled; anything else propagates (#343).
async function responseErrorMessage(res, fallback) {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && data.error) return data.error;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return `${fallback} (HTTP ${res.status})`;
}

const DelegatesModule = {
  async fetchDelegates() {
    const res = await fetch('/api/delegates');
    if (!res.ok) throw new Error('Failed to load delegates');
    return await res.json();
  },

  async grantDelegate({ delegateUserId, calendarId, role, canManageInvitations, canViewPrivate, canManageDelegates }) {
    const res = await fetch('/api/delegates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegateUserId,
        calendarId: calendarId || null,
        role: role || 'DELEGATE_WRITE',
        canManageInvitations: canManageInvitations ? 1 : 0,
        canViewPrivate: canViewPrivate ? 1 : 0,
        canManageDelegates: canManageDelegates ? 1 : 0
      })
    });
    if (!res.ok) {
      throw new Error(await responseErrorMessage(res, 'Failed to grant delegate permission'));
    }
    return await res.json();
  },

  async revokeDelegate(id) {
    const res = await fetch(`/api/delegates/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to revoke delegate permission');
    return await res.json();
  },

  renderDelegatesList(delegates, containerEl, onRevoke) {
    if (!containerEl) return;
    if (!delegates || delegates.length === 0) {
      containerEl.innerHTML = '<div class="text-sm text-slate-500 py-2">Keine Stellvertretung eingerichtet.</div>';
      return;
    }

    containerEl.innerHTML = delegates.map(d => `
      <div class="delegate-item flex items-center justify-between p-3 bg-slate-50 border rounded-lg mb-2" data-id="${escHtml(d.id)}">
        <div>
          <div class="font-semibold text-slate-800 text-sm">${escHtml(d.delegate_user_id)}</div>
          <div class="text-xs text-slate-500">
            Rolle: <span class="font-medium text-slate-700">${escHtml(d.role)}</span> | 
            Einladungen: ${d.can_manage_invitations ? 'Ja' : 'Nein'} | 
            Privat: ${d.can_view_private ? 'Ja' : 'Nein'}
          </div>
        </div>
        <button type="button" class="revoke-delegate-btn text-xs text-red-600 hover:text-red-800 font-medium px-2 py-1 border border-red-200 rounded hover:bg-red-50" data-id="${escHtml(d.id)}">
          Entfernen
        </button>
      </div>
    `).join('');

    containerEl.querySelectorAll('.revoke-delegate-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (id && onRevoke) await onRevoke(id);
      });
    });
  }
};

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (typeof window !== 'undefined') {
  window.DelegatesModule = DelegatesModule;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DelegatesModule;
}
