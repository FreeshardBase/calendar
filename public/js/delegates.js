'use strict';

/**
 * FreeShard WebCalendar — Delegate Permissions & Executive Assistant Management Frontend Engine
 */
const DelegatesModule = {
  async fetchDelegates() {
    try {
      const res = await fetch('/api/delegates');
      if (!res.ok) throw new Error('Failed to load delegates');
      return await res.json();
    } catch (err) {
      console.error('[DelegatesModule] fetchDelegates error:', err.message);
      return { delegates: [], principals: [] };
    }
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
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to grant delegate permission');
    }
    return await res.json();
  },

  async revokeDelegate(id) {
    const res = await fetch(`/api/delegates/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to revoke delegate permission');
    return await res.json();
  },

  async setActAsPrincipal(principalUserId, calendarId = null) {
    const res = await fetch('/api/delegates/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ principalUserId, calendarId })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to activate delegation context');
    }
    return await res.json();
  },

  renderDelegatesList(delegates, containerEl, onRevoke) {
    if (!containerEl) return;
    if (!delegates || delegates.length === 0) {
      containerEl.innerHTML = '<div class="text-sm text-slate-500 py-2">Keine Stellvertreter eingerichtet.</div>';
      return;
    }

    containerEl.innerHTML = delegates.map(d => `
      <div class="delegate-item flex items-center justify-between p-3 bg-slate-50 border rounded-lg mb-2" data-id="${d.id}">
        <div>
          <div class="font-semibold text-slate-800 text-sm">${d.delegate_user_id}</div>
          <div class="text-xs text-slate-500">
            Rolle: <span class="font-medium text-slate-700">${d.role}</span> | 
            Einladungen: ${d.can_manage_invitations ? 'Ja' : 'Nein'} | 
            Privat: ${d.can_view_private ? 'Ja' : 'Nein'}
          </div>
        </div>
        <button type="button" class="revoke-delegate-btn text-xs text-red-600 hover:text-red-800 font-medium px-2 py-1 border border-red-200 rounded hover:bg-red-50" data-id="${d.id}">
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

if (typeof window !== 'undefined') {
  window.DelegatesModule = DelegatesModule;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DelegatesModule;
}
