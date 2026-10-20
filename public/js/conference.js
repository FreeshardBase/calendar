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

const $ = id => document.getElementById(id);
const DEFAULT_BASE_URL = 'https://meet.jit.si';
const ROOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // 32 letters: 5 random bits each
const ROOM_LENGTH = 20; // 100 bits, so nobody guesses a room
const DESCRIPTION_PREFIX = 'Videokonferenz: ';

export function randomRoomName() {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_LENGTH));
  return 'freeshard-' + Array.from(bytes, b => ROOM_ALPHABET[b & 31]).join('');
}

function consentText(baseUrl) {
  const host = new URL(baseUrl).host;
  return `„Videokonferenz hinzufügen“ im Termin-Dialog erzeugt einen Link mit zufälligem Raumnamen auf ${host}. `
    + `Der Shard sendet dafür nichts dorthin; erst wer den Link öffnet, auch eingeladene Personen, verbindet sich mit ${host}. `
    + 'Wer den Link kennt, kann dem Raum beitreten.';
}

// ── Settings ────────────────────────────────────────────────────────────────

export function renderConferenceSettings() {
  const baseUrl = store.get('conferenceBaseUrl');
  $('conference-enabled').checked = Boolean(baseUrl);
  $('conference-form').classList.toggle('hidden', !baseUrl);
  $('conference-base-url').value = baseUrl || DEFAULT_BASE_URL;
  $('conference-error').classList.add('hidden');
  $('conference-notice').textContent = baseUrl
    ? consentText(baseUrl)
    : 'Aus: Der Termin-Dialog bietet keinen Konferenz-Link an.';
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
      error.textContent = 'Bitte die Adresse des Jitsi-Servers eintragen, z. B. https://meet.jit.si.';
      error.classList.remove('hidden');
      $('conference-base-url').focus();
      return;
    }
    error.classList.add('hidden');
    if (!(await confirmDialog(consentText(value), 'Videokonferenz-Links einschalten?'))) {
      renderConferenceSettings();
      return;
    }
    saveBaseUrl(value).catch(fail);
  });
}

// ── Event dialog ────────────────────────────────────────────────────────────

function removeDescriptionLine(description, url) {
  const line = DESCRIPTION_PREFIX + url;
  return description.split('\n').filter(l => l.trim() !== line).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
    description.value = (text ? text + '\n\n' : '') + DESCRIPTION_PREFIX + url;
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
