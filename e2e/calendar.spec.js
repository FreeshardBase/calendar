const { test, expect } = require('@playwright/test');

test.describe('FreeShard WebCalendar E2E Suite', () => {

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

});
