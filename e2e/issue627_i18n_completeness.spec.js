const { test, expect } = require('./fixtures.js');

// Issue #627: every module speaks the i18n layer. The rendered DOM of every view (and the
// dialogs and the booking page) is scanned in English and in Deutsch (Sie): in English no German
// is left, in Sie nothing says "du", and no raw message key shows anywhere. The scan reads
// what the browser renders, not the source, so a string that bypasses t() is caught wherever
// it ends up. User data (event and task titles, calendar names) is not UI copy and is skipped.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

const USER_DATA = [
  '.event-chip-title', '.event-block-title', '.agenda-event-title', '.kanban-card-title',
  '.task-list-title', '.task-subtask-title', '.calendar-name', '.settings-item-name', '.share-user-name',
  '#pref-language option', '#pref-time-zone option', '#holiday-region-select option',
  '[data-user-content]', '.event-chip', '.event-block', '.agenda-event', '.kanban-card', '.task-list-item',
  '.list-row', '.list-event-title',
].join(',');

const GERMAN = /[äöüßÄÖÜ]|\b(der|die|das|und|nicht|kein|keine|einen?|mit|für|von|bis|ist|wird|werden|Termine?|Aufgaben?|Bitte|Neue[rs]?|Heute|Woche|Monat|Liste|Erledigt|Offen|ganztägig|Ganztägig|Uhr|Einstellungen|Abbrechen|Speichern|Schließen|Löschen|weitere)\b/;
const DU = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|hast|bist|kannst|möchtest|willst|musst)\b/i;
const RAW_KEY = /^[a-z][A-Za-z]*(\.[A-Za-z0-9-]+){2,}$/;

// Visible text and the title/aria-label/placeholder of visible elements, outside user data
// (calendar names, such as the provisioned "Persönlich", are the user's, wherever they show).
async function uiStrings(page, root = 'body') {
  const calendars = page.url().includes('/public/booking/') ? []
    : (await (await page.request.get('/api/calendars')).json()).calendars.map(cal => cal.displayName || cal.name);
  const strings = await page.evaluate(({ root, userData }) => {
    const out = [];
    const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    for (const el of document.querySelectorAll(`${root}, ${root} *`)) {
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(el.tagName)) continue;
      if (el.closest(userData)) continue;
      if (el.tagName !== 'OPTION' && !visible(el)) continue;
      if (el.tagName === 'OPTION' && !visible(el.closest('select'))) continue;
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim()) out.push(node.textContent.trim());
      }
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        if (el.getAttribute(attr)) out.push(el.getAttribute(attr).trim());
      }
    }
    return out;
  }, { root, userData: USER_DATA });
  return strings.filter(text => !calendars.includes(text));
}

function offending(strings, lang) {
  return strings.filter(text => RAW_KEY.test(text)
    || (lang === 'en' && GERMAN.test(text)) || (lang === 'de-formal' && DU.test(text)));
}

async function setLanguage(page, language) {
  const res = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { language } });
  expect(res.ok()).toBeTruthy();
}

test.afterEach(async ({ page }) => {
  await setLanguage(page, null);
});

const VIEWS = ['month', 'week', 'workweek', '3day', 'day', 'agenda', 'list', 'kanban'];

for (const lang of ['en', 'de-formal']) {
  test(`Issue #627 — every view, the dialogs and the booking page render in ${lang} with no untranslated string`, async ({ page }) => {
    test.setTimeout(120000);
    await setLanguage(page, lang);
    await page.addInitScript(() => {
      if (window.origin === 'null') return;
      window.localStorage.setItem('welcome-popup-closed', 'true');
    });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/?date=2041-03-13');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('html')).toHaveAttribute('data-ui-language', lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang === 'en' ? 'en' : 'de');

    const found = {};
    const scan = async (where, root) => {
      const bad = offending(await uiStrings(page, root), lang);
      if (bad.length) found[where] = bad;
    };

    for (const view of VIEWS) {
      await page.click(`#view-${view}`);
      await expect(page.locator(`#view-${view}`)).toHaveAttribute('aria-pressed', 'true');
      await page.waitForLoadState('networkidle');
      await scan(view, 'body');
    }
    // The task view's other layout (list ↔ board).
    const toggle = page.locator('[data-task-view]:not(.active), #task-view-toggle').first();
    if (await toggle.count()) {
      await toggle.click();
      await scan('kanban (other layout)', 'body');
    }

    await page.click('#view-month');
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await scan('event dialog', '#event-modal-backdrop');
    await page.keyboard.press('Escape');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal')).toBeVisible();
    await scan('task dialog', '#task-modal');
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-modal')).toBeHidden();

    await page.click('#sidebar-settings-btn');
    await expect(page.locator('#pref-language')).toBeVisible();
    await scan('settings', 'body');

    expect(found).toEqual({});
    expect(errors).toEqual([]);
  });
}

test('Issue #627 — the public booking page follows the browser language', async ({ page }) => {
  // No user is logged in there: the browser's language decides, then Deutsch (Du).
  await page.addInitScript(() => {
    const wanted = window.localStorage.getItem('test-627-languages');
    if (wanted) Object.defineProperty(navigator, 'languages', { get: () => JSON.parse(wanted) });
  });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  for (const [languages, expected] of [[['en-US', 'en'], 'en'], [['fr-FR', 'de-DE'], 'de']]) {
    await page.goto('/public/booking/?slug=testuser-627-missing');
    await page.evaluate(value => window.localStorage.setItem('test-627-languages', value), JSON.stringify(languages));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ui-language', expected);
    expect(offending(await uiStrings(page), expected)).toEqual([]);
  }
  expect(errors).toEqual([]);
});
