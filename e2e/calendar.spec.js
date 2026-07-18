const { test, expect } = require('@playwright/test');

test.describe('FreeShard WebCalendar E2E Suite', () => {

  test.beforeEach(async ({ page }) => {
    // The one-time welcome modal (shown when only the internal calendar account
    // exists) would intercept clicks — mark it as already dismissed.
    await page.addInitScript(() => localStorage.setItem('welcome-popup-closed', 'true'));
  });

  test('should load the page, bypass onboarding, and display calendar', async ({ page }) => {
    // Go to homepage
    await page.goto('/');

    // Loading screen should become hidden
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });

    // Onboarding should be hidden (since the test account is auto-configured in session)
    await expect(page.locator('#onboarding')).toHaveClass(/hidden/);

    // App layout should be visible
    await expect(page.locator('#app')).not.toHaveClass(/hidden/);

    // Sidebar should have the calendar list
    await expect(page.locator('#calendar-list')).toBeVisible();

    // Verify calendar list contains the default "Persönlich" calendar
    await expect(page.locator('#calendar-list')).toContainText('Persönlich');
  });

  test('should open event modal, create an event, view popover, and delete it', async ({ page }) => {
    await page.goto('/');

    // Wait for app to be ready and calendar list to populate
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Click "Neuer Termin" button
    await page.click('#new-event-btn');

    // Modal should be visible
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    // Fill title
    const uniqueTitle = `E2E Playwright Event - ${Date.now()}`;
    await page.fill('#ev-title', uniqueTitle);

    // Save event
    await page.click('#event-save-btn');

    // Modal should close
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // Check that event chip with title is visible in calendar view
    const eventChip = page.locator(`.event-chip:has-text("${uniqueTitle}")`).first();
    await expect(eventChip).toBeVisible({ timeout: 10000 });

    // Click on event chip to show popover
    await eventChip.click();

    // Popover should be visible
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await expect(page.locator('#event-popover .popover-title')).toHaveText(uniqueTitle);

    // Click "Löschen" in popover
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('löschen');
      await dialog.accept(); // Confirm deletion
    });
    await page.click('#popover-delete-btn');

    // Event chip should disappear
    await expect(eventChip).not.toBeVisible();
  });

  test('should create recurring event, delete and edit single occurrences via scope dialog', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Create a weekly recurring event
    await page.click('#new-event-btn');
    const title = `Recurring E2E ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.selectOption('#ev-recurrence', 'WEEKLY');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    const chips = page.locator(`.event-chip:has-text("${title}")`);
    await expect(chips.first()).toBeVisible({ timeout: 10000 });
    const countBefore = await chips.count();
    expect(countBefore).toBeGreaterThan(1);

    // Delete only the second occurrence
    await chips.nth(1).click();
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-occurrence-btn');
    await expect(chips).toHaveCount(countBefore - 1, { timeout: 10000 });

    // Edit only the first occurrence (retitle)
    const movedTitle = `Moved E2E ${Date.now()}`;
    await chips.first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await page.fill('#ev-title', movedTitle);
    await page.click('#event-save-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-occurrence-btn');

    const movedChip = page.locator(`.event-chip:has-text("${movedTitle}")`);
    await expect(movedChip).toHaveCount(1, { timeout: 10000 });
    await expect(chips).toHaveCount(countBefore - 2, { timeout: 10000 });

    // Clean up: delete the whole series (also removes the detached exception)
    await chips.first().click();
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-series-btn');
    await expect(chips).toHaveCount(0, { timeout: 10000 });
    await expect(movedChip).toHaveCount(0, { timeout: 10000 });
  });

  test('should switch views between month, week, workweek, day, and agenda on desktop', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // 1. Switch to Week View
    await page.click('#view-week');
    await expect(page.locator('.week-view')).toBeVisible();

    // 2. Switch to Workweek View
    await page.click('#view-workweek');
    await expect(page.locator('.week-view')).toBeVisible();
    const headerRow = page.locator('.week-header-row');
    await expect(headerRow).toHaveAttribute('style', /repeat\(5,\s*1fr\)/);

    // 3. Switch to Day View
    await page.click('#view-day');
    await expect(page.locator('.day-view')).toBeVisible();

    // 4. Switch to Agenda View
    await page.click('#view-agenda');
    await expect(page.locator('.agenda-view')).toBeVisible();

    // 5. Switch back to Month View
    await page.click('#view-month');
    await expect(page.locator('.month-grid')).toBeVisible();
  });

  test('should layout toolbar responsively and switch views on mobile viewport', async ({ page }) => {
    // Set viewport to mobile size
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify mobile menu hamburger button is visible
    const menuBtn = page.locator('#menu-btn');
    await expect(menuBtn).toBeVisible();

    // Switch view to Workweek on mobile
    await page.click('#view-workweek');
    await expect(page.locator('.week-view')).toBeVisible();
  });

  test('should open share dialog, autocomplete user, add share, and revoke share', async ({ page }) => {
    // Autocompleting "Aaron Gryzia" requires a CalDAV server with real user
    // principals — only runs against a configured external account.
    test.skip(!process.env.CALDAVURL, 'No CALDAV credentials configured');

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Wait for calendar list items
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible();

    // Click on the share button of the first calendar item
    const shareBtn = page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]');
    await shareBtn.click();

    // Verify share dialog is open
    await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();

    // Fill "aar" in the search input
    const searchInput = page.locator('#share-search-input');
    await searchInput.fill('aar');

    // Wait for autocomplete dropdown to become visible
    const dropdown = page.locator('#share-autocomplete-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify it contains Aaron Gryzia
    await expect(dropdown).toContainText('Aaron Gryzia');

    // Click the autocomplete item for Aaron Gryzia
    await dropdown.locator('.autocomplete-item').first().click();

    // Verify input value has updated to the email address
    await expect(searchInput).toHaveValue('aaron@gryzia.de');

    // 1. Click "Hinzufügen" to add the share
    const addBtn = page.locator('#share-add-btn');
    await addBtn.click();

    // 2. Verify share shows up in the list
    const listContainer = page.locator('#share-list-container');
    await expect(listContainer).toContainText('Aaron Gryzia', { timeout: 10000 });

    // 3. Change role/permission of existing share to read-only ("false")
    const roleToggle = listContainer.locator('.share-role-toggle').first();
    await expect(roleToggle).toHaveValue('true');
    await roleToggle.selectOption('false');

    // Wait for the dropdown to be re-enabled (means update finished and reload occurred)
    await expect(roleToggle).not.toBeDisabled({ timeout: 10000 });
    await expect(roleToggle).toHaveValue('false');

    // 4. Click delete / revoke button
    const revokeBtn = listContainer.locator('.btn-revoke-share').first();
    page.on('dialog', async dialog => {
      expect(dialog.message()).toContain('entziehen');
      await dialog.accept(); // Confirm revocation
    });
    await revokeBtn.click();

    // 5. Verify share is removed from list
    await expect(listContainer).not.toContainText('Aaron Gryzia', { timeout: 10000 });
  });

});
