const { test, expect } = require('./fixtures.js');
const { ERROR_CODES } = require('../server/utils/errorSanitizer.js');

// Issue #628: the settings are one dialog with a section per topic and a topic list that moves the
// focus to its section, styled through design tokens instead of inline styles. Server errors reach
// the UI as codes with parameters and are shown in the user's language (#160), never as the
// server's own text.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

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

test('Issue #628 — the settings dialog: topics, keyboard navigation, focus and no inline styles', async ({ page }) => {
  const errors = await openApp(page);
  await page.click('#sidebar-settings-btn');
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
  await expect(dialog).toBeVisible();

  const nav = dialog.getByRole('navigation', { name: 'Bereiche der Einstellungen' });
  const topics = nav.getByRole('button');
  await expect(topics).toHaveText(['Allgemein', 'Konten & Kalender', 'Arbeitszeiten & Abwesenheit', 'Dienste', 'Benachrichtigungen']);

  // Each topic is a labelled region holding its settings.
  await expect(dialog.getByRole('region', { name: 'Allgemein' }).locator('#pref-language')).toBeAttached();
  await expect(dialog.getByRole('region', { name: 'Konten & Kalender' }).locator('#settings-account-list')).toBeAttached();
  await expect(dialog.getByRole('region', { name: 'Konten & Kalender' }).locator('#settings-trash-list')).toBeAttached();
  await expect(dialog.getByRole('region', { name: 'Arbeitszeiten & Abwesenheit' }).locator('#wh-save-btn')).toBeAttached();
  await expect(dialog.getByRole('region', { name: 'Dienste' }).locator('#weather-enabled')).toBeAttached();
  await expect(dialog.getByRole('region', { name: 'Benachrichtigungen' }).locator('#request-notification-btn')).toBeAttached();

  // Clicking a topic brings its section into view and puts the focus on its heading.
  await topics.nth(3).click();
  const servicesHeading = dialog.getByRole('heading', { name: 'Dienste', level: 3 });
  await expect(servicesHeading).toBeFocused();
  await expect(servicesHeading).toBeInViewport();
  await expect(topics.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(topics.nth(0)).not.toHaveAttribute('aria-current', /.*/);

  // Keyboard: arrows, Home and End move between topics, Enter opens one.
  await topics.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(topics.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(topics.nth(4)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(topics.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(topics.nth(4)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(topics.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const accountsHeading = dialog.getByRole('heading', { name: 'Konten & Kalender', level: 3 });
  await expect(accountsHeading).toBeFocused();
  await expect(accountsHeading).toBeInViewport();

  // The dialog's look comes from the stylesheet's tokens, not from inline styles (the rendered
  // account, calendar and app password rows are drawn by app.js and not part of this markup).
  await expect(page.locator('#settings-drawer [style]:not(.settings-list *)')).toHaveCount(0);

  // The topics follow the UI language.
  await page.selectOption('#pref-language', 'en');
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('navigation', { name: 'Settings sections' }).getByRole('button'))
    .toHaveText(['General', 'Accounts & calendars', 'Working hours & out of office', 'Services', 'Notifications']);

  // Escape closes the dialog and hands the focus back to the settings button.
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-drawer')).toBeHidden();
  await expect(page.locator('#sidebar-settings-btn')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Issue #628 — a server error is shown translated (#160), in German and in English', async ({ page }) => {
  // The server answers a code and its parameters.
  const refused = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { weekStart: 'friday' } });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'INVALID_PREFERENCE', params: { name: 'weekStart' } });
  const unknown = await page.request.get('/api/no-such-route');
  expect(await unknown.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

  const errors = await openApp(page);
  const toasts = page.locator('#toast-container');
  const saveWithCredentials = async () => {
    await page.click('#sidebar-settings-btn');
    await page.locator('#conference-enabled').check();
    // The client lets this through; the server refuses an address with credentials.
    await page.locator('#conference-base-url').fill('https://testuser:secret@meet.example.org');
    await page.click('#conference-save-btn');
    await page.click('#confirm-dialog-ok');
  };

  await saveWithCredentials();
  await expect(toasts).toContainText('Der Jitsi-Server muss eine http(s)-Adresse ohne Zugangsdaten, Abfrage oder Fragment sein.');

  await page.selectOption('#pref-language', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Escape');
  await saveWithCredentials();
  await expect(toasts).toContainText('The Jitsi server must be an http(s) address without credentials, query or fragment.');
  await expect(toasts).not.toContainText('conferenceBaseUrl');

  // A weekday parameter (0 = Sunday) is named in the UI language.
  const overlap = await page.evaluate(async () => {
    const { responseErrorMessage } = await import('/js/api.js');
    const body = { error: 'Wochentag 1 (0 = Sonntag): Zeitfenster dürfen sich nicht überschneiden.', code: 'BOOKING_WINDOW_OVERLAP', params: { weekday: 1 } };
    return responseErrorMessage(new Response(JSON.stringify(body), { status: 400 }));
  });
  expect(overlap).toBe('Monday: time windows must not overlap.');
  expect(errors).toEqual([]);

  // Every code the server answers has a message in every UI language.
  const missing = await page.evaluate(async codes => {
    const { catalogues } = await import('/js/i18n.js');
    return Object.entries(catalogues).flatMap(([lang, catalogue]) =>
      codes.filter(code => !Object.hasOwn(catalogue, `serverError.${code}`)).map(code => `${lang}: ${code}`));
  }, ERROR_CODES);
  expect(missing).toEqual([]);
});
