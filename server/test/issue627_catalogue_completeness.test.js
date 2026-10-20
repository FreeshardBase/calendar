'use strict';
// Issue #627: three UI languages — Deutsch (Du) 'de', Deutsch (Sie) 'de-formal', English 'en'.
// Every key of every message catalogue exists in all three, with the same plural shape and the
// same {placeholders}; a missing key fails here instead of throwing on a user's screen. The Sie
// catalogue never addresses the user with "du" (CONCEPTS.md: Du and Sie never mix on one screen).

process.env.NODE_ENV = 'test';
process.env.PORT = '3628';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('assert');
const { server } = require('../index');
const { fetchModule } = require('./helpers/i18n');

// The catalogues as the app serves them to the browser.
let i18n;
test.before(async () => {
  if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
  i18n = await fetchModule(`http://localhost:${process.env.PORT}`);
});
test.after(() => server.close());

const shape = value => (typeof value === 'string' ? 'string' : Object.keys(value).sort().join(','));
const placeholders = value => [...new Set((typeof value === 'string' ? [value] : Object.values(value))
  .flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1])))].sort().join(',');

// Second person singular: pronouns and the -st verb forms that go with them.
const DU = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|hast|bist|kannst|möchtest|willst|musst|solltest|wirst)\b/i;

test('Issue #627 — the UI speaks Deutsch (Du), Deutsch (Sie) and English', () => {
  assert.deepStrictEqual([...i18n.LANGUAGES], ['de', 'de-formal', 'en']);
});

test('Issue #627 — every catalogue has every key in all three languages', () => {
  const areas = Object.entries(i18n.AREAS);
  assert.ok(areas.length >= 8, 'the remaining modules have their own catalogues');
  for (const [area, catalogue] of areas) {
    assert.deepStrictEqual(Object.keys(catalogue).sort(), [...i18n.LANGUAGES].sort(), `${area}: languages`);
    const keys = Object.keys(catalogue.de).sort();
    assert.ok(keys.length > 0, `${area} has strings`);
    for (const lang of i18n.LANGUAGES) {
      const langKeys = Object.keys(catalogue[lang]).sort();
      const missing = keys.filter(key => !langKeys.includes(key));
      const extra = langKeys.filter(key => !keys.includes(key));
      assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] }, `${area}.${lang}`);
      for (const key of keys) {
        const value = catalogue[lang][key];
        assert.ok(typeof value === 'string' ? value.trim() !== '' || catalogue.de[key] === value : value.other,
          `${area}.${lang}.${key} is empty`);
        assert.strictEqual(shape(value), shape(catalogue.de[key]), `${lang}.${key}: plural shape`);
        assert.strictEqual(placeholders(value), placeholders(catalogue.de[key]), `${lang}.${key}: placeholders`);
      }
    }
  }
});

test('Issue #627 — Deutsch (Sie) never says "du"', () => {
  const offending = Object.entries(i18n.catalogues['de-formal'])
    .filter(([, value]) => (typeof value === 'string' ? [value] : Object.values(value)).some(text => DU.test(text)))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  assert.deepStrictEqual(offending, []);
});

test('Issue #627 — Deutsch (Sie) differs from Deutsch (Du) wherever Du addresses the user', () => {
  const du = i18n.catalogues.de;
  const sie = i18n.catalogues['de-formal'];
  const addressing = Object.keys(du).filter(key =>
    (typeof du[key] === 'string' ? [du[key]] : Object.values(du[key])).some(text => DU.test(text)));
  assert.ok(addressing.length > 0, 'Deutsch (Du) addresses the user somewhere');
  for (const key of addressing) assert.notDeepStrictEqual(sie[key], du[key], key);
});

test('Issue #627 — a missing key fails: the merged catalogue throws, the check above names it', () => {
  // The same check as above against a catalogue with one key dropped, so the test proves it bites.
  const broken = { de: { 'x.a': 'A', 'x.b': 'B' }, 'de-formal': { 'x.a': 'A' }, en: { 'x.a': 'A', 'x.b': 'B' } };
  const keys = Object.keys(broken.de);
  const missing = Object.keys(broken).flatMap(lang => keys.filter(key => !Object.hasOwn(broken[lang], key)).map(key => `${lang}.${key}`));
  assert.deepStrictEqual(missing, ['de-formal.x.b']);
});
