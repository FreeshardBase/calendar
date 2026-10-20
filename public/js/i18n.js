/**
 * i18n.js — the UI language and its message catalogues (#626).
 *
 * The language is resolved in the order of CONCEPTS.md: the user's calendar setting, the platform
 * preference (freeshard#168, not offered by shard_core yet, so skipped), the browser's
 * navigator.languages, then Deutsch (Du). Each module's strings live in public/js/messages/<area>.js
 * as { de: {...}, 'de-formal': {...}, en: {...} }; a key missing from the active language throws,
 * it never shows the key or another language. 'de' is Deutsch (Du), 'de-formal' Deutsch (Sie)
 * (#627); the browser never picks Sie, only the user's setting does.
 *
 * Messages may hold {name} placeholders; a plural message is an object keyed by the
 * Intl.PluralRules categories ({ one, other }) and is chosen by params.count.
 * Static markup is translated through attributes: data-i18n="key" sets the text, and
 * data-i18n-<attribute>="key" sets that attribute (data-i18n-title, data-i18n-placeholder,
 * data-i18n-aria-label, …).
 */

import shell from './messages/shell.js';
import app from './messages/app.js';
import eventModal from './messages/eventModal.js';
import calendarLabels from './messages/calendarLabels.js';
import tasks from './messages/tasks.js';
import views from './messages/views.js';
import modules from './messages/modules.js';
import booking from './messages/booking.js';
import serverErrors from './messages/serverErrors.js';

export const LANGUAGES = ['de', 'de-formal', 'en'];
// The BCP 47 tag each UI language formats dates and plurals in (the page's lang).
const LOCALE_TAGS = { de: 'de', 'de-formal': 'de', en: 'en' };
export const DEFAULT_LANGUAGE = 'de';

export const AREAS = { shell, app, eventModal, calendarLabels, tasks, views, modules, booking, serverErrors };

function merge(lang) {
  const all = {};
  for (const area of Object.values(AREAS)) {
    for (const [key, value] of Object.entries(area[lang])) {
      if (Object.hasOwn(all, key)) throw new Error(`Duplicate message key: ${key}`);
      all[key] = value;
    }
  }
  return all;
}

export const catalogues = Object.fromEntries(LANGUAGES.map(lang => [lang, merge(lang)]));

let current = DEFAULT_LANGUAGE;

export const language = () => current;

// The browser's first supported language ("en-GB" → "en"), else Deutsch (Du).
export function browserLanguage() {
  const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const lang = String(tag || '').split('-')[0].toLowerCase();
    if (LANGUAGES.includes(lang)) return lang;
  }
  return DEFAULT_LANGUAGE;
}

// The language to show for the user's setting (null = not chosen).
export const resolveLanguage = chosen => (chosen && LANGUAGES.includes(chosen) ? chosen : browserLanguage());

const pluralRules = new Map();

function pluralCategory(lang, count) {
  if (!pluralRules.has(lang)) pluralRules.set(lang, new Intl.PluralRules(LOCALE_TAGS[lang]));
  return pluralRules.get(lang).select(count);
}

export function t(key, params = {}) {
  const catalogue = catalogues[current];
  if (!Object.hasOwn(catalogue, key)) throw new Error(`Missing message "${key}" for language "${current}"`);
  let message = catalogue[key];
  if (typeof message === 'object') {
    if (typeof params.count !== 'number') throw new Error(`Message "${key}" is a plural and needs params.count`);
    message = message[pluralCategory(current, params.count)] ?? message.other;
  }
  return message.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Message "${key}" needs the parameter "${name}"`);
    return String(params[name]);
  });
}

const ATTR_PREFIX = 'data-i18n-';

// Translates every data-i18n / data-i18n-<attribute> element in `root` (and root itself).
export function translateDom(root = document) {
  const elements = root.querySelectorAll('*');
  for (const el of root.nodeType === 1 ? [root, ...elements] : elements) {
    for (const attr of [...el.attributes]) {
      if (attr.name === 'data-i18n') el.textContent = t(attr.value);
      else if (attr.name.startsWith(ATTR_PREFIX)) el.setAttribute(attr.name.slice(ATTR_PREFIX.length), t(attr.value));
    }
  }
}

// Switches the UI to `lang`: the page's lang (which locale.js formats dates in), the static
// markup, and a 'ui-language-changed' event for the modules that render their own strings.
export function setLanguage(lang) {
  if (!LANGUAGES.includes(lang)) throw new Error(`Unsupported language: ${lang}`);
  current = lang;
  document.documentElement.lang = LOCALE_TAGS[lang];
  document.documentElement.dataset.uiLanguage = lang;
  translateDom(document);
  window.dispatchEvent(new CustomEvent('ui-language-changed', { detail: { language: lang } }));
}
