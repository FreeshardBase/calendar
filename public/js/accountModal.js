/**
 * accountModal.js — Add CalDAV account modal controller.
 */

import { AccountsAPI } from './api.js';
import { showToast } from './app.js';
import { wirePresetSelect } from './caldavPresets.js';

let _onAdded = null;

const $ = id => document.getElementById(id);

export function openAccountModal(callbacks) {
  _onAdded = callbacks?.onAdded;
  $('account-form').reset();
  $('account-form-error').classList.add('hidden');
  setLoading(false);
  $('account-modal-backdrop').classList.remove('hidden');
  setTimeout(() => $('acc-url').focus(), 50);
}

export function closeAccountModal() {
  $('account-modal-backdrop').classList.add('hidden');
}

export function initAccountModal() {
  $('account-modal-close').addEventListener('click', closeAccountModal);
  $('account-cancel-btn').addEventListener('click', closeAccountModal);

  wirePresetSelect($('acc-provider'), $('acc-url'), $('acc-username'));

  $('btn-link-google').addEventListener('click', () => {
    const width = 600;
    const height = 650;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;
    const popup = window.open(
      '/api/auth/google',
      'google-oauth',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
    );
    if (popup) popup.focus();
  });


  $('account-form').addEventListener('submit', async e => {
    e.preventDefault();

    const url         = $('acc-url').value.trim();
    const username    = $('acc-username').value.trim();
    const password    = $('acc-password').value;
    const displayName = $('acc-displayname').value.trim();

    if (!url || !username || !password) {
      showError('Bitte alle Pflichtfelder ausfüllen.');
      return;
    }

    setLoading(true);
    $('account-form-error').classList.add('hidden');

    try {
      const result = await AccountsAPI.add({ url, username, password, displayName });
      closeAccountModal();
      showToast(`Account „${displayName || username}" hinzugefügt.`, 'success');
      _onAdded?.(result);
    } catch (err) {
      showError(err.message);
      setLoading(false);
    }
  });

  $('account-modal-backdrop').addEventListener('click', e => {
    if (e.target === $('account-modal-backdrop')) closeAccountModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('account-modal-backdrop').classList.contains('hidden')) {
      closeAccountModal();
    }
  });
}

function showError(msg) {
  const el = $('account-form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setLoading(on) {
  const btn = $('account-save-btn');
  btn.querySelector('.btn-label').style.display = on ? 'none' : '';
  btn.querySelector('.btn-spinner').classList.toggle('hidden', !on);
  btn.disabled = on;
}
