const { test, expect } = require('./fixtures.js');

// Issue #626: a small i18n layer (public/js/i18n.js) with Deutsch (Du) and English catalogues.
// The language is the user's setting, else the browser's, else Deutsch (Du); switching it
// re-renders the shell and the event dialog without a reload.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

async function prefs(page) {
  return (await page.request.get('/api/preferences')).json();
}

async function openApp(page) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('/?date=2037-05-06');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  return errors;
}

async function expectGerman(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#today-btn')).toHaveText('Heute');
  await expect(page.locator('#view-week')).toHaveText('Woche');
  await expect(page.locator('#new-event-btn')).toContainText('Neuer Termin');
  await expect(page.locator('#settings-drawer-title')).toHaveText('Einstellungen');
}

async function expectEnglish(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#today-btn')).toHaveText('Today');
  await expect(page.locator('#view-week')).toHaveText('Week');
  await expect(page.locator('#new-event-btn')).toContainText('New event');
  await expect(page.locator('#settings-drawer-title')).toHaveText('Settings');
}

// The setting is stored for the run's one user; later specs expect it unset.
test.afterEach(async ({ page }) => {
  const res = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { language: null } });
  expect(res.ok()).toBeTruthy();
});

async function chooseLanguage(page, value) {
  await page.click('#sidebar-settings-btn');
  await page.selectOption('#pref-language', value);
  await expect.poll(async () => (await prefs(page)).language).toBe(value === '' ? null : value);
}

test('Issue #626 — switching the language re-renders the shell and the event dialog without reload', async ({ page }) => {
  const errors = await openApp(page);
  // Not chosen, browser de-DE: German stays the default.
  await expectGerman(page);
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-title')).toHaveText('Neuer Termin');
  await page.keyboard.press('Escape');
  await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

  let loads = 0;
  page.on('load', () => { loads += 1; });
  await chooseLanguage(page, 'en');
  // The settings drawer itself follows at once.
  await expect(page.locator('label[for="pref-language"]')).toHaveText('Language');
  await expect(page.locator('#pref-language')).toHaveValue('en');
  // What app.js renders follows as well: the settings list names its collections in English.
  const typeLabels = page.locator('#settings-calendar-list .settings-item-type');
  await expect(typeLabels.first()).toBeVisible();
  await expect.poll(async () => (await typeLabels.allTextContents())
    .filter(text => !['Calendar', 'Task list', 'Mixed'].includes(text.trim()))).toEqual([]);
  await page.click('#close-settings-btn');
  await expectEnglish(page);
  // The dates follow the UI language too (locale.js reads the page's lang).
  await expect(page.locator('#toolbar-title')).toContainText('May 2037');

  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-title')).toHaveText('New event');
  await expect(page.locator('#event-modal')).not.toContainText('Ganztägig');
  await page.keyboard.press('Escape');
  await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
  expect(loads).toBe(0);

  // The choice is the user's: it survives a reload, and "Same as the browser" goes back to German.
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expectEnglish(page);
  await chooseLanguage(page, '');
  await expect(page.locator('label[for="pref-language"]')).toHaveText('Sprache');
  await page.click('#close-settings-btn');
  await expectGerman(page);
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-title')).toHaveText('Neuer Termin');
  expect(errors).toEqual([]);
});

test.describe('Issue #626 — an English browser', () => {
  test.use({ locale: 'en-US' });

  test('Issue #626 — without a setting an English browser gets English', async ({ page }) => {
    await openApp(page);
    await expectEnglish(page);
  });
});

test.describe('Issue #626 — a browser in a language the app does not speak', () => {
  test.use({ locale: 'fr-FR' });

  test('Issue #626 — without a setting a French browser gets Deutsch (Du)', async ({ page }) => {
    await openApp(page);
    await expectGerman(page);
  });

  test('Issue #626 — the setting wins over the browser', async ({ page }) => {
    const res = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { language: 'en' } });
    expect(res.status()).toBe(200);
    await openApp(page);
    await expectEnglish(page);
  });
});

test('Issue #626 — both catalogues hold the same keys, placeholders and plurals; t() fills them', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const i18n = await import('/js/i18n.js');
    const { de, en } = i18n.catalogues;
    const placeholders = m => [...new Set(JSON.stringify(m).match(/\{\w+\}/g) || [])].sort().join(',');
    const shape = m => (typeof m === 'object' ? `plural:${Object.keys(m).includes('other')}` : 'text');
    const mismatched = [...new Set([...Object.keys(de), ...Object.keys(en)])].filter(key =>
      !(key in de) || !(key in en) || placeholders(de[key]) !== placeholders(en[key]) || shape(de[key]) !== shape(en[key])
      || shape(de[key]) === 'plural:false');
    const emptyText = Object.keys(de).filter(key => [de[key], en[key]].some(m => typeof m === 'string' && !m.trim()));
    // A plural message of the catalogue picks its form by count, in both languages.
    const differs = m => typeof m === 'object' && 'one' in m && m.one !== m.other;
    const pluralKey = Object.keys(en).find(key => differs(en[key]) && differs(de[key]));
    const plurals = {};
    for (const lang of ['de', 'en']) {
      i18n.setLanguage(lang);
      const params = Object.fromEntries((placeholders(en[pluralKey]).match(/\w+/g) || []).map(p => [p, 'x']));
      plurals[lang] = [i18n.t(pluralKey, { ...params, count: 1 }), i18n.t(pluralKey, { ...params, count: 2 })];
    }
    const throws = fn => { try { fn(); return false; } catch (err) { return err instanceof Error; } };
    return {
      keys: Object.keys(de).length,
      mismatched,
      emptyText,
      pluralKey,
      plurals,
      unknownThrows: throws(() => i18n.t('no.such.key')),
      pluralWithoutCount: throws(() => i18n.t(pluralKey)),
      lang: document.documentElement.lang,
    };
  });
  expect(result.mismatched).toEqual([]);
  expect(result.emptyText).toEqual([]);
  expect(result.keys).toBeGreaterThan(300);
  expect(result.pluralKey).toBeTruthy();
  for (const lang of ['de', 'en']) expect(result.plurals[lang][0]).not.toBe(result.plurals[lang][1]);
  expect(result.plurals.de[0]).not.toBe(result.plurals.en[0]);
  expect(result.unknownThrows).toBe(true);
  expect(result.pluralWithoutCount).toBe(true);
  expect(result.lang).toBe('en');
});
