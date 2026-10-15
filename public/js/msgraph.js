import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';
import { responseErrorMessage } from './api.js';
import { showToast } from './app.js';

export const MSGraphAPI = {
  // { available, accounts }: available is false when the shard has no Microsoft app registration.
  async listAccounts() {
    const res = await fetch('/api/msgraph/accounts');
    if (!res.ok) throw new Error('Fehler beim Laden der MS Graph Konten');
    const data = await res.json();
    return { available: data.available === true, accounts: data.accounts };
  },

  async deleteAccount(accountId) {
    const res = await fetch(`/api/msgraph/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      throw new Error(await responseErrorMessage(res, 'Fehler beim Trennen des MS Graph Kontos'));
    }
    return await res.json();
  },

  async syncAccount(accountId) {
    const res = await fetch(`/api/msgraph/accounts/${encodeURIComponent(accountId)}/sync`, {
      method: 'POST'
    });
    if (!res.ok) {
      throw new Error(await responseErrorMessage(res, 'Fehler beim Synchronisieren des MS Graph Kontos'));
    }
    return await res.json();
  }
};

const $ = id => document.getElementById(id);

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function openMSGraphModal() {
  const backdrop = $('msgraph-modal-backdrop');
  if (backdrop) openDialog(backdrop, $('msgraph-modal-close'));
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
    const { available, accounts } = await MSGraphAPI.listAccounts();
    $('msgraph-unavailable').classList.toggle('hidden', available);
    $('msgraph-connect-actions').classList.toggle('hidden', !available);
    if (accounts.length === 0) {
      list.innerHTML = '<p class="empty-state">Keine Office 365 Konten verbunden.</p>';
      return;
    }
    list.innerHTML = accounts.map(a => `
      <div class="settings-item msgraph-account" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:6px 8px; border:1px solid var(--border); border-radius:4px;">
        <div style="min-width:0; flex:1;">
          <strong>${escHtml(a.accountEmail)}</strong>
          ${a.reconnectRequired
            ? '<div class="msgraph-reconnect-required" style="font-size:0.75rem; color:var(--danger);">Autorisierung abgelaufen – bitte neu verbinden.</div>'
            : ''}
        </div>
        <div style="display:flex; gap:6px;">
          ${a.reconnectRequired
            ? (available ? '<a class="btn btn-ghost btn-sm btn-reconnect-msgraph" href="/api/msgraph/authorize">Neu verbinden</a>' : '')
            : `<button class="btn btn-ghost btn-sm btn-sync-msgraph" data-id="${escHtml(a.id)}" title="Synchronisieren">Sync</button>`}
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
          showToast('Synchronisierung gestartet; sie läuft im Hintergrund.', 'success');
        } catch (e) {
          showToast(e.message, 'error');
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
          showToast('MS Graph Konto getrennt.', 'info');
          loadMSGraphAccounts();
        } catch (e) {
          showToast(e.message, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state" style="color:var(--danger);">${escHtml(err.message)}</p>`;
  }
}

// The OAuth callback returns to /?msgraph=connected|error; report it once and drop the parameter.
function reportAuthorizationResult() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get('msgraph');
  if (!result) return;
  url.searchParams.delete('msgraph');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  if (result === 'connected') {
    showToast('Microsoft 365 Konto verbunden. Die Synchronisierung läuft im Hintergrund.', 'success');
  } else {
    showToast('Verbindung mit Microsoft 365 fehlgeschlagen. Bitte erneut versuchen.', 'error');
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

  reportAuthorizationResult();
}
