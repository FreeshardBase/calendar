/**
 * caldavPresets.js — Autoconfiguration presets for popular CalDAV providers.
 *
 * Only the base host is needed: the backend runs full service discovery
 * (/.well-known/caldav + current-user-principal + calendar-home-set) on the
 * given URL when the account is added.
 */

export const CALDAV_PRESETS = [
  {
    id: 'gmx',
    label: 'GMX',
    url: 'https://caldav.gmx.net',
    usernameHint: 'deine@gmx.de'
  },
  {
    id: 'webde',
    label: 'WEB.DE',
    url: 'https://caldav.web.de',
    usernameHint: 'deine@web.de'
  },
  {
    id: 'mailboxorg',
    label: 'mailbox.org',
    url: 'https://dav.mailbox.org',
    usernameHint: 'deine@mailbox.org'
  },
  {
    id: 'posteo',
    label: 'Posteo',
    url: 'https://posteo.de:8443',
    usernameHint: 'deine@posteo.de'
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud (eigene Instanz)',
    url: '',
    urlHint: 'https://cloud.example.com/remote.php/dav',
    usernameHint: 'benutzername'
  }
];

/**
 * Populate a provider <select> and wire it to prefill the URL field and
 * adjust the username placeholder. Manual entry stays the default.
 */
export function wirePresetSelect(selectEl, urlInput, usernameInput) {
  selectEl.innerHTML =
    '<option value="">Anderer Anbieter (manuell)</option>' +
    CALDAV_PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('');

  selectEl.addEventListener('change', () => {
    const preset = CALDAV_PRESETS.find(p => p.id === selectEl.value);
    if (!preset) return;
    urlInput.value = preset.url;
    if (preset.urlHint) urlInput.placeholder = preset.urlHint;
    if (preset.usernameHint) usernameInput.placeholder = preset.usernameHint;
    (preset.url ? usernameInput : urlInput).focus();
  });
}
