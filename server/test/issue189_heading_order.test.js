'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.resolve(__dirname, '../../public/index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function appHeadingTags(source) {
  const appStart = source.indexOf('id="app"');
  if (appStart === -1) return [];
  const appSlice = source.slice(appStart);
  const tags = [];
  const re = /<(h[1-6])[\s>]/gi;
  let m;
  while ((m = re.exec(appSlice)) !== null) {
    tags.push(m[1].toLowerCase());
  }
  return tags;
}

test('Issue #189 — Heading hierarchy in main application view', async (t) => {

  await t.test('A visually-hidden <h1> exists inside #app', () => {
    assert.match(html, /id="app"[\s\S]*?<h1[^>]*class="[^"]*sr-only[^"]*"/);
  });

  await t.test('The h1 text content is "FreeShard Calendar"', () => {
    assert.match(html, /<h1[^>]*class="[^"]*sr-only[^"]*"[^>]*>\s*FreeShard Calendar\s*<\/h1>/);
  });

  await t.test('The settings-drawer section heading is <h2>, not <h4>', () => {
    assert.doesNotMatch(html, /<h4[^>]*>\s*Einstellungen\s*<\/h4>/);
    assert.match(html, /<h2[^>]*>\s*Einstellungen\s*<\/h2>/);
  });

  await t.test('Settings sub-section headings are <h3>, not <h5>', () => {
    const subSections = [
      'Accounts verwalten',
      'Kalender löschen',
      'App-Passwörter',
      'Erscheinungsbild',
      'Zeitzonen-Grid',
      'Arbeitszeiten',
    ];
    for (const label of subSections) {
      assert.doesNotMatch(html, new RegExp(`<h5[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(html, new RegExp(`<h3[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  await t.test('The toolbar title is <h3>, not <h2>', () => {
    assert.doesNotMatch(html, /<h2[^>]*class="[^"]*toolbar-title[^"]*"/);
    assert.match(html, /<h3[^>]*class="[^"]*toolbar-title[^"]*"/);
  });

  await t.test('No heading in #app starts the outline at h4 or deeper without a preceding h1', () => {
    const tags = appHeadingTags(html);
    assert.ok(tags.length > 0, 'Headings should exist in #app');
    const firstLevel = parseInt(tags[0].replace('h', ''), 10);
    assert.ok(firstLevel <= 2, 'First heading in #app should not be h4 or deeper');
  });

  await t.test('No h2 appears in #app before the h1 (no skipped top level)', () => {
    const tags = appHeadingTags(html);
    const h1Index = tags.indexOf('h1');
    const h2Index = tags.indexOf('h2');
    assert.ok(h1Index >= 0, 'An h1 must exist in #app');
    if (h2Index !== -1) {
      assert.ok(h2Index > h1Index, 'h2 must appear after h1 in #app');
    }
  });
});
