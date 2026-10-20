/**
 * conference.js — Issue #521: one-click video conference link (Jitsi), opt-in.
 *
 * Off until the user sets a Jitsi server in the settings; switching it on asks first and says
 * where the link leads. "Videokonferenz hinzufügen" in the event dialog then appends a random
 * room name to that server: no API call, the shard contacts nobody. The link is saved as the
 * event's CONFERENCE (RFC 7986) and as a line in the description, for clients without CONFERENCE.
 */

import { store } from './store.js';
import { PreferencesAPI } from './api.js';
import { confirmDialog } from './dialogFocus.js';
import { t, catalogues, LANGUAGES } from './i18n.js';

const $ = id => document.getElementById(id);
const DEFAULT_BASE_URL = 'https://meet.jit.si';
const ROOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // 32 letters: 5 random bits each
const ROOM_LENGTH = 20; // 100 bits, so nobody guesses a room
const DESCRIPTION_PREFIX_KEY = 'modules.conference.descriptionPrefix';

export function randomRoomName() {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_LENGTH));
  return 'freeshard-' + Array.from(bytes, b => ROOM_ALPHABET[b & 31]).join('');
}

function consentText(baseUrl) {
  return t('modules.conference.consent', { host: new URL(baseUrl).host });
}

// ── Settings ────────────────────────────────────────────────────────────────

function renderNotice() {
  const baseUrl = store.get('conferenceBaseUrl');
  $('conference-notice').textContent = baseUrl ? consentText(baseUrl) : t('modules.conference.off');
}

export function renderConferenceSettings() {
  const baseUrl = store.get('conferenceBaseUrl');
  $('conference-enabled').checked = Boolean(baseUrl);
  $('conference-form').classList.toggle('hidden', !baseUrl);
  $('conference-base-url').value = baseUrl || DEFAULT_BASE_URL;
  $('conference-error').classList.add('hidden');
  renderNotice();
}

async function saveBaseUrl(baseUrl) {
  const saved = (await PreferencesAPI.setConferenceBaseUrl(baseUrl)).conferenceBaseUrl;
  store.set({ conferenceBaseUrl: saved });
  renderConferenceSettings();
}

export function initConferenceSettings(onError) {
  const fail = err => {
    renderConferenceSettings();
    onError(err);
  };

  window.addEventListener('ui-language-changed', () => {
    renderNotice();
    if (!$('conference-error').classList.contains('hidden')) $('conference-error').textContent = t('modules.conference.invalidUrl');
  });

  // Ticking the box only opens the form; nothing is on before "Speichern".
  $('conference-enabled').addEventListener('change', e => {
    if (e.target.checked) {
      $('conference-form').classList.remove('hidden');
      $('conference-base-url').focus();
    } else if (store.get('conferenceBaseUrl')) {
      saveBaseUrl(null).catch(fail);
    } else {
      renderConferenceSettings();
    }
  });

  $('conference-form').addEventListener('submit', async e => {
    e.preventDefault();
    const value = $('conference-base-url').value.trim();
    const error = $('conference-error');
    if (!/^https?:\/\/[^\s?#]+$/.test(value) || !URL.canParse(value)) {
      error.textContent = t('modules.conference.invalidUrl');
      error.classList.remove('hidden');
      $('conference-base-url').focus();
      return;
    }
    error.classList.add('hidden');
    if (!(await confirmDialog(consentText(value), t('modules.conference.confirmTitle')))) {
      renderConferenceSettings();
      return;
    }
    saveBaseUrl(value).catch(fail);
  });
}

// ── Event dialog ────────────────────────────────────────────────────────────

// The line may have been written in another UI language than the current one.
function removeDescriptionLine(description, url) {
  const lines = new Set(LANGUAGES.map(lang => catalogues[lang][DESCRIPTION_PREFIX_KEY] + url));
  return description.split('\n').filter(l => !lines.has(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Wires the "Videokonferenz hinzufügen" button. Returns { set(url), get() }: the event's video link
 * or null. The button shows only while the user has a Jitsi server set and the event has no link.
 */
export function createConferenceField() {
  const addBtn = $('ev-conference-add');
  const box = $('ev-conference');
  const link = $('ev-conference-link');
  const description = $('ev-description');
  let url = null;

  function render() {
    addBtn.classList.toggle('hidden', Boolean(url) || !store.get('conferenceBaseUrl'));
    box.classList.toggle('hidden', !url);
    link.textContent = url || '';
    if (url) link.href = url;
    else link.removeAttribute('href');
  }

  addBtn.addEventListener('click', () => {
    url = `${store.get('conferenceBaseUrl')}/${randomRoomName()}`;
    const text = description.value.trim();
    description.value = (text ? text + '\n\n' : '') + t(DESCRIPTION_PREFIX_KEY) + url;
    render();
    link.focus();
  });

  $('ev-conference-remove').addEventListener('click', () => {
    description.value = removeDescriptionLine(description.value, url);
    url = null;
    render();
    (addBtn.classList.contains('hidden') ? description : addBtn).focus();
  });

  return {
    set(value) {
      url = value || null;
      render();
    },
    get: () => url,
  };
}
