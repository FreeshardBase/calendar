/**
 * accountModal.js — Add CalDAV account modal controller.
 */

import { AccountsAPI } from './api.js';
import { showToast } from './app.js';
import { openMSGraphModal } from './msgraph.js';
import { openDialog, closeDialog } from './dialogFocus.js';

let _onAdded = null;

const $ = id => document.getElementById(id);

// #353: a CalDAV provider either has a fixed server (the URL field stays hidden) or asks for its
// own address. The fixed URLs match server/utils/caldavPresets.js.
const PROVIDERS = {
  custom:    { urlLabel: 'CalDAV Server URL', placeholder: 'https://dav.example.com/calendars/user/' },
  gmx:       { url: 'https://caldav.gmx.net/begenda/dav/' },
  webde:     { url: 'https://caldav.web.de/begenda/dav/' },
  mailbox:   { url: 'https://dav.mailbox.org/caldav/' },
  posteo:    { url: 'https://posteo.de:8443/calendars/' },
  icloud:    { url: 'https://caldav.icloud.com/',
               hint: 'Apple verlangt ein app-spezifisches Passwort (appleid.apple.com → Anmeldung und Sicherheit).' },
  fastmail:  { url: 'https://caldav.fastmail.com/dav/',
               hint: 'Fastmail verlangt ein app-spezifisches Passwort (Einstellungen → Passwörter & Sicherheit).' },
  nextcloud: { urlLabel: 'Adresse deiner Nextcloud', placeholder: 'https://cloud.example.com',
               hint: 'Mit Zwei-Faktor-Anmeldung brauchst du ein App-Passwort (Einstellungen → Sicherheit).' },
};

const DOMAIN_PROVIDERS = {
  'gmx.de': 'gmx', 'gmx.net': 'gmx', 'gmx.at': 'gmx', 'gmx.ch': 'gmx',
  'web.de': 'webde',
  'mailbox.org': 'mailbox',
  'posteo.de': 'posteo', 'posteo.net': 'posteo', 'posteo.org': 'posteo', 'posteo.at': 'posteo', 'posteo.ch': 'posteo',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail',
};

function applyProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unbekannter Kalender-Anbieter: ${id}`);
  $('acc-provider').value = id;
  $('acc-url-group').classList.toggle('hidden', Boolean(provider.url));
  $('acc-url').value = provider.url || '';
  $('acc-url').placeholder = provider.placeholder || '';
  document.querySelector('label[for="acc-url"]').textContent = provider.urlLabel || 'CalDAV Server URL';
  const hint = $('acc-provider-hint');
  hint.textContent = provider.hint || '';
  hint.classList.toggle('hidden', !provider.hint);
}

export function openAccountModal(callbacks) {
  _onAdded = callbacks?.onAdded;
  $('account-form').reset();
  $('account-form-error').classList.add('hidden');
  setLoading(false);
  const provider = callbacks?.provider || 'custom';
  applyProvider(provider);
  openDialog($('account-modal-backdrop'), PROVIDERS[provider].url ? $('acc-username') : $('acc-url'));
}

export function closeAccountModal() {
  closeDialog($('account-modal-backdrop'));
}

function openGoogleSignIn() {
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
}

/** #353: a provider tile (data-provider) starts that provider's way of linking an account. */
export function startProviderLink(provider, onAdded) {
  if (provider === 'google') openGoogleSignIn();
  else if (provider === 'msgraph') openMSGraphModal();
  else openAccountModal({ onAdded, provider });
}

export function initAccountModal() {
  $('account-modal-close').addEventListener('click', closeAccountModal);
  $('account-cancel-btn').addEventListener('click', closeAccountModal);

  $('acc-provider').addEventListener('change', () => applyProvider($('acc-provider').value));

  // An address of a known provider picks its server, unless a provider was chosen already.
  $('acc-username').addEventListener('input', () => {
    if ($('acc-provider').value !== 'custom') return;
    const val = $('acc-username').value.trim();
    if (!val.includes('@')) return;
    const matched = DOMAIN_PROVIDERS[val.split('@').pop().toLowerCase()];
    if (matched) applyProvider(matched);
  });

  $('btn-link-google').addEventListener('click', openGoogleSignIn);

  const btnMSGraph = $('btn-link-msgraph');
  if (btnMSGraph) {
    btnMSGraph.addEventListener('click', () => {
      closeAccountModal();
      openMSGraphModal();
    });
  }


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
      showToast(`Account „${displayName || username}“ hinzugefügt.`, 'success');
      _onAdded?.(result);
    } catch (err) {
      showError(err.message);
      setLoading(false);
    }
  });

  $('account-modal-backdrop').addEventListener('click', e => {
    if (e.target === $('account-modal-backdrop')) closeAccountModal();
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
