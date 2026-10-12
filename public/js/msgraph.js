import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';

export const MSGraphAPI = {
  async listAccounts() {
    const res = await fetch('/api/msgraph/accounts');
    if (!res.ok) throw new Error('Fehler beim Laden der MS Graph Konten');
    const data = await res.json();
    return data.accounts || [];
  },

  async addAccount(accountData) {
    const res = await fetch('/api/msgraph/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountData)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Fehler beim Verbinden mit Office 365');
    }
    return await res.json();
  },

  async deleteAccount(accountId) {
    const res = await fetch(`/api/msgraph/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Fehler beim Trennen des MS Graph Kontos');
    }
    return await res.json();
  },

  async syncAccount(accountId, localEvents = []) {
    const res = await fetch(`/api/msgraph/accounts/${encodeURIComponent(accountId)}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localEvents })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Fehler beim Synchronisieren des MS Graph Kontos');
    }
    return await res.json();
  }
};

const $ = id => document.getElementById(id);

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function openMSGraphModal() {
  const form = $('msgraph-form');
  if (form) form.reset();
  const backdrop = $('msgraph-modal-backdrop');
  if (backdrop) openDialog(backdrop, $('msgraph-email'));
  loadMSGraphAccounts();
}

export function closeMSGraphModal() {
  const backdrop = $('msgraph-modal-backdrop');
  if (backdrop) closeDialog(backdrop);
}

export async function loadMSGraphAccounts() {
  const list = $('msgraph-accounts-list');
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Lade MS Graph Konten...</p>';
  try {
    const accounts = await MSGraphAPI.listAccounts();
    if (!accounts || accounts.length === 0) {
      list.innerHTML = '<p class="empty-state">Keine Office 365 Konten verbunden.</p>';
      return;
    }
    list.innerHTML = accounts.map(a => `
      <div class="settings-item" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:6px 8px; border:1px solid var(--border); border-radius:4px;">
        <div style="min-width:0; flex:1;">
          <strong>${escHtml(a.accountEmail)}</strong>
          <div style="font-size:0.75rem; color:var(--ink-muted);">Tenant: ${escHtml(a.tenantId || 'common')}</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-ghost btn-sm btn-sync-msgraph" data-id="${escHtml(a.id)}" title="Synchronisieren">Sync</button>
          <button class="btn btn-ghost btn-sm btn-danger btn-delete-msgraph" data-id="${escHtml(a.id)}" title="Entfernen">Trennen</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.btn-sync-msgraph').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          btn.disabled = true;
          await MSGraphAPI.syncAccount(id);
          if (typeof window.showToast === 'function') window.showToast('MS Graph Konto synchronisiert.', 'success');
        } catch (e) {
          if (typeof window.showToast === 'function') window.showToast(e.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    list.querySelectorAll('.btn-delete-msgraph').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!(await confirmDialog('MS Graph Konto wirklich trennen?'))) return;
        try {
          btn.disabled = true;
          await MSGraphAPI.deleteAccount(id);
          if (typeof window.showToast === 'function') window.showToast('MS Graph Konto getrennt.', 'info');
          loadMSGraphAccounts();
        } catch (e) {
          if (typeof window.showToast === 'function') window.showToast(e.message, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state" style="color:var(--danger);">${escHtml(err.message)}</p>`;
  }
}

export function initMSGraphModal() {
  const closeBtn = $('msgraph-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMSGraphModal);

  const backdrop = $('msgraph-modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeMSGraphModal();
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && backdrop && !backdrop.classList.contains('hidden')) {
      closeMSGraphModal();
    }
  });

  const form = $('msgraph-form');
  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const accountEmail = $('msgraph-email')?.value?.trim();
      const tenantId = $('msgraph-tenant')?.value?.trim() || 'common';
      if (!accountEmail) return;

      const width = 600;
      const height = 650;
      const left = (window.screen.width - width) / 2;
      const top = (window.screen.height - height) / 2;
      const popup = window.open(
        `/api/msgraph/authorize?tenantId=${encodeURIComponent(tenantId)}`,
        'msgraph-oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
      );
      if (popup) popup.focus();
    });
  }

  window.addEventListener('message', async e => {
    if (e.origin !== window.location.origin) return;
    if (e.data === 'msgraph-account-linked') {
      if (typeof window.showToast === 'function') {
        window.showToast('Office 365 Kalender erfolgreich verknüpft!', 'success');
      }
      if (form) form.reset();
      await loadMSGraphAccounts();
    }
  });
}

