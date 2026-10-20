const { test, expect } = require('./fixtures.js');

// Issue #353: the first run ends on the user's own (internal) calendar in one click, and linking an
// external account starts from provider tiles (Google, Microsoft 365, iCloud, Nextcloud, other
// CalDAV) instead of a URL to type. Each test's user is fresh (#592), so the welcome dialog shows.
test.use({ serviceWorkers: 'block' });

const welcome = page => page.locator('#welcome-modal-backdrop');
const tile = (scope, name) => scope.getByRole('button', { name, exact: true });

async function openWelcome(page) {
  await page.goto('/');
  await expect(welcome(page)).toBeVisible({ timeout: 10000 });
}

test.describe('Issue #353 — first run and account linking', () => {
  test('the welcome dialog says what syncs where and its primary action opens the own calendar', async ({ page }) => {
    await openWelcome(page);
    const dialog = welcome(page);
    await expect(dialog).toContainText('auf deinem Shard');
    await expect(dialog).toContainText('in beide Richtungen');
    await expect(dialog.getByRole('button', { name: /Später/ })).toHaveCount(0);
    for (const name of ['Google', 'Microsoft 365', 'iCloud', 'Nextcloud', 'Andere (CalDAV)']) {
      await expect(tile(dialog, name)).toBeVisible();
    }

    const primary = dialog.locator('.btn-primary');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveText('Kalender jetzt nutzen');
    await primary.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
  });

  test('the iCloud tile preselects the server, hides the URL and validates the credentials', async ({ page }) => {
    let posted = null;
    await page.route('**/api/accounts', route => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 401, json: { error: 'Ungültige Zugangsdaten.' } });
    });
    await openWelcome(page);
    await tile(welcome(page), 'iCloud').click();

    await expect(welcome(page)).toBeHidden();
    const modal = page.locator('#account-modal-backdrop');
    await expect(modal).toBeVisible();
    await expect(page.locator('#acc-provider')).toHaveValue('icloud');
    await expect(page.locator('#acc-url')).toBeHidden();
    await expect(page.locator('#acc-provider-hint')).toContainText('app-spezifisches Passwort');
    await expect(page.locator('#acc-username')).toBeFocused();

    await page.fill('#acc-username', 'testuser@example.com');
    await page.fill('#acc-password', 'wrong-password');
    await page.click('#account-save-btn');
    await expect(page.locator('#account-form-error')).toHaveText('Ungültige Zugangsdaten.');
    expect(posted).toMatchObject({ url: 'https://caldav.icloud.com/', username: 'testuser@example.com' });
  });

  test('the Nextcloud tile asks only for the server address, "Andere" for the full CalDAV URL', async ({ page }) => {
    await openWelcome(page);
    await tile(welcome(page), 'Nextcloud').click();
    await expect(page.locator('#acc-provider')).toHaveValue('nextcloud');
    await expect(page.locator('#acc-url')).toBeVisible();
    await expect(page.locator('#acc-url')).toHaveValue('');
    await expect(page.locator('label[for="acc-url"]')).toHaveText('Adresse deiner Nextcloud');
    await expect(page.locator('#acc-url')).toBeFocused();

    await page.selectOption('#acc-provider', 'custom');
    await expect(page.locator('label[for="acc-url"]')).toHaveText('CalDAV Server URL');
    await page.selectOption('#acc-provider', 'fastmail');
    await expect(page.locator('#acc-url')).toBeHidden();
    await expect(page.locator('#acc-url')).toHaveValue('https://caldav.fastmail.com/dav/');
  });

  test('the Microsoft 365 tile opens the Microsoft sign-in', async ({ page }) => {
    await openWelcome(page);
    await tile(welcome(page), 'Microsoft 365').click();
    await expect(welcome(page)).toBeHidden();
    await expect(page.locator('#msgraph-modal-backdrop')).toBeVisible();
  });

  test('the Google tile opens the Google sign-in', async ({ page }) => {
    await page.context().route('**/api/auth/google', route => route.fulfill({ contentType: 'text/html', body: '<p>google</p>' }));
    await openWelcome(page);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      tile(welcome(page), 'Google').click(),
    ]);
    expect(new URL(popup.url()).pathname).toBe('/api/auth/google');
    await expect(welcome(page)).toBeHidden();
  });

  test('without any account the onboarding offers the same tiles, Microsoft 365 included', async ({ page }) => {
    await page.route('**/api/accounts', route => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const onboarding = page.locator('#onboarding');
    await expect(onboarding).toBeVisible({ timeout: 10000 });
    for (const name of ['Google', 'Microsoft 365', 'iCloud', 'Nextcloud', 'Andere (CalDAV)']) {
      await expect(tile(onboarding, name)).toBeVisible();
    }
    await expect(onboarding.locator('input[type="url"]')).toHaveCount(0);

    await tile(onboarding, 'Andere (CalDAV)').click();
    await expect(page.locator('#account-modal-backdrop')).toBeVisible();
    await expect(page.locator('#acc-provider')).toHaveValue('custom');
    await expect(page.locator('#acc-url')).toBeVisible();
  });
});
