const { test, expect } = require('./fixtures.js');

// Issue #514: public holidays are a built-in subscription. Choosing a country and state in the
// settings adds a read-only "Feiertage" calendar to the sidebar; it can be hidden, and the week and
// day views shade its days as non-working. Fronleichnam 2037 is Thursday 4 June (Bavaria, not Berlin).
const HOLIDAY_UID = 'holiday-DE-BY-2037-06-04';
// Local midnight in the browser's zone (Europe/Berlin), as createTimeCol stores it.
const THURSDAY = '2037-06-03T22:00:00.000Z';
const WEDNESDAY = '2037-06-02T22:00:00.000Z';

test.use({ serviceWorkers: 'block' });

test('Issue #514 — holidays chosen in the settings show as a hideable, read-only, non-working calendar', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto('/?date=2037-06-04');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click('#view-week');
  const week = page.locator('#calendar-container .week-view');
  await expect(week).toBeVisible({ timeout: 10000 });
  const col = date => week.locator(`.week-day-col[data-date="${date}"]`);
  const holidayChip = page.locator(`#calendar-container [data-event-uid="${HOLIDAY_UID}"]`);
  const sidebarItem = page.locator('#holiday-list [data-holiday-item]');

  await expect(sidebarItem).toHaveCount(0);
  await expect(col(THURSDAY)).not.toHaveClass(/non-working-day/);

  // Settings: the state picker appears once a country is chosen.
  await page.click('#sidebar-settings-btn');
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
  const country = page.locator('#holiday-country');
  const region = page.locator('#holiday-region');
  await expect(country).toHaveValue('');
  await expect(region).toBeHidden();
  await country.selectOption('DE');
  await expect(region).toBeVisible();
  await region.selectOption('DE-BY');
  await expect.poll(async () => (await (await page.request.get('/api/holidays/settings')).json()).region)
    .toBe('DE-BY');
  await page.click('#close-settings-btn');

  await expect(sidebarItem).toHaveCount(1);
  await expect(sidebarItem).toContainText('Feiertage (Bayern)');
  await expect(sidebarItem).toHaveAttribute('aria-checked', 'true');
  await expect(holidayChip).toHaveText('Fronleichnam');
  await expect(col(THURSDAY)).toHaveClass(/non-working-day/);
  await expect(col(WEDNESDAY)).not.toHaveClass(/non-working-day/);

  // Read-only: the popover offers no edit or delete.
  await holidayChip.click();
  await expect(page.locator('#event-popover .popover-title')).toHaveText('Fronleichnam');
  await expect(page.locator('#event-popover')).toContainText('Abonnement (schreibgeschützt)');
  await expect(page.locator('#popover-delete-btn')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Hidden: the chip and the shading go; shown again, both return.
  await sidebarItem.click();
  await expect(sidebarItem).toHaveAttribute('aria-checked', 'false');
  await expect(holidayChip).toHaveCount(0);
  await expect(col(THURSDAY)).not.toHaveClass(/non-working-day/);
  await sidebarItem.press('Enter');
  await expect(sidebarItem).toHaveAttribute('aria-checked', 'true');
  await expect(holidayChip).toHaveText('Fronleichnam');

  // The day view shades the holiday too; the choice survives a reload.
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click('#view-day');
  await expect(page.locator('#calendar-container .day-view .week-day-col')).toHaveClass(/non-working-day/);
  await expect(holidayChip).toHaveText('Fronleichnam');

  // Another state has other holidays: Berlin has no Fronleichnam.
  await page.click('#sidebar-settings-btn');
  await expect(country).toHaveValue('DE');
  await expect(region).toHaveValue('DE-BY');
  await region.selectOption('DE-BE');
  await page.click('#close-settings-btn');
  await expect(sidebarItem).toContainText('Feiertage (Berlin)');
  await expect(page.locator('#calendar-container .day-view .week-day-col')).not.toHaveClass(/non-working-day/);
  await expect(page.locator('#calendar-container [data-event-uid^="holiday-"]')).toHaveCount(0);

  // Switching off removes the calendar.
  await page.click('#sidebar-settings-btn');
  await country.selectOption('');
  await expect(region).toBeHidden();
  await page.click('#close-settings-btn');
  await expect(sidebarItem).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get('/api/holidays/settings')).json()).region)
    .toBe(null);
});
