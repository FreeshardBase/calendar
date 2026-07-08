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

    // Wait for app to be ready
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

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

});
