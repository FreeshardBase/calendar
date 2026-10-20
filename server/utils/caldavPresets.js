'use strict';

/**
 * caldavPresets.js — Autoconfiguration presets for popular CalDAV providers.
 * Supports GMX, WEB.DE, mailbox.org, Posteo, iCloud, Fastmail.
 */

const CALDAV_PRESETS = {
  gmx: {
    id: 'gmx',
    name: 'GMX',
    domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    url: 'https://caldav.gmx.net/begenda/dav/'
  },
  webde: {
    id: 'webde',
    name: 'WEB.DE',
    domains: ['web.de'],
    url: 'https://caldav.web.de/begenda/dav/'
  },
  mailbox: {
    id: 'mailbox',
    name: 'mailbox.org',
    domains: ['mailbox.org'],
    url: 'https://dav.mailbox.org/caldav/'
  },
  posteo: {
    id: 'posteo',
    name: 'Posteo',
    domains: ['posteo.de', 'posteo.net', 'posteo.org', 'posteo.at', 'posteo.ch'],
    url: 'https://posteo.de:8443/calendars/'
  },
  // #353: provider tiles of the first run. Both need an app-specific password.
  icloud: {
    id: 'icloud',
    name: 'iCloud',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    url: 'https://caldav.icloud.com/'
  },
  fastmail: {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    url: 'https://caldav.fastmail.com/dav/'
  }
};

/**
 * Get list of available CalDAV provider presets.
 * @returns {Array<Object>}
 */
function getPresets() {
  return Object.values(CALDAV_PRESETS).map(p => ({
    id: p.id,
    name: p.name,
    domains: [...p.domains],
    url: p.url
  }));
}

/**
 * Resolve provider preset by ID or email address.
 * @param {string} input - Preset ID (e.g. 'gmx') or email (e.g. 'user@posteo.de').
 * @returns {Object|null}
 */
function resolvePreset(input) {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim().toLowerCase();

  if (CALDAV_PRESETS[trimmed]) {
    const p = CALDAV_PRESETS[trimmed];
    return { id: p.id, name: p.name, domains: [...p.domains], url: p.url };
  }

  if (trimmed.includes('@')) {
    const domain = trimmed.split('@').pop();
    for (const p of Object.values(CALDAV_PRESETS)) {
      if (p.domains.includes(domain)) {
        return { id: p.id, name: p.name, domains: [...p.domains], url: p.url };
      }
    }
  }

  return null;
}

/**
 * Resolve full CalDAV URL from input string (URL, preset ID, or email address).
 * @param {string} input
 * @returns {string|null}
 */
function resolveCalDAVUrl(input) {
  if (!input || typeof input !== 'string') return null;

  const preset = resolvePreset(input);
  if (preset) return preset.url;

  if (input.startsWith('http://') || input.startsWith('https://')) {
    return input.trim();
  }

  return input.trim();
}

module.exports = {
  CALDAV_PRESETS,
  getPresets,
  resolvePreset,
  resolveCalDAVUrl
};
