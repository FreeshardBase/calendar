'use strict';

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
