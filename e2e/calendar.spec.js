const { test, expect } = require('@playwright/test');

test.describe('FreeShard WebCalendar E2E Suite', () => {

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err));
    // The one-time welcome modal (shown when only the internal calendar account
    // exists) would intercept clicks — mark it as already dismissed.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('welcome-popup-closed', 'true');
      } catch (e) {}
    });
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
    await page.goto('/?date=2026-07-06');
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

  test('should import a dropped ICS file and export a calendar as download', async ({ page }) => {
    await page.goto('/?date=2026-07-06');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });



    // Build an ICS with one event on 2026-07-06 and simulate dropping it on the sidebar
    const title = `Imported E2E ${Date.now()}`;
    const d = new Date('2026-07-06T10:00:00Z');
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:e2e-import-${Date.now()}`,
      `DTSTART:${ymd}T090000Z`,
      `DTEND:${ymd}T100000Z`,
      `SUMMARY:${title}`,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');

    await page.evaluate((icsText) => {
      const dt = new DataTransfer();
      dt.items.add(new File([icsText], 'drop.ics', { type: 'text/calendar' }));
      document.querySelector('.sidebar').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    }, ics);

    await expect(page.locator('#import-dialog-backdrop')).toBeVisible();
    await page.click('#import-confirm');

    const chip = page.locator(`.event-chip:has-text("${title}")`).first();
    await expect(chip).toBeVisible({ timeout: 10000 });

    // Export button triggers a .ics download
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#calendar-list [data-export-cal]').first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.ics$/);

    // Clean up the imported event
    await chip.click();
    page.on('dialog', dialog => dialog.accept());
    await page.click('#popover-delete-btn');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
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
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify mobile menu hamburger button is visible
    const menuBtn = page.locator('#menu-btn');
    await expect(menuBtn).toBeVisible();

    // Switch view to Day on mobile
    await page.evaluate(() => document.querySelector('#view-day').click());
    await expect(page.locator('#view-day')).toHaveClass(/active/);
    await expect(page.locator('.day-view')).toBeAttached();
  });

  test('should open share dialog, autocomplete user, add share, and revoke share', async ({ page }) => {
    // Autocompleting "Test User" requires a CalDAV server with real user
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

    // Fill "testuser" in the search input
    const searchInput = page.locator('#share-search-input');
    await searchInput.fill('testuser');

    // Wait for autocomplete dropdown to become visible
    const dropdown = page.locator('#share-autocomplete-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify it contains testuser@example.com
    await expect(dropdown).toContainText('testuser@example.com');

    // Click the autocomplete item for testuser@example.com
    await dropdown.locator('.autocomplete-item', { hasText: 'testuser@example.com' }).click();

    // Verify input value has updated to the email address
    await expect(searchInput).toHaveValue('testuser@example.com');

    // 1. Click "Hinzufügen" to add the share
    const addBtn = page.locator('#share-add-btn');
    await addBtn.click();

    // 2. Verify share shows up in the list
    const listContainer = page.locator('#share-list-container');
    await expect(listContainer).toContainText('testuser@example.com', { timeout: 10000 });

    // 3. Change role/permission of existing share to read-only ("false")
    const roleToggle = listContainer.locator('.share-role-toggle').first();
    await roleToggle.selectOption('false');
    await roleToggle.evaluate(el => el.dispatchEvent(new Event('change')));

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
    await expect(listContainer).not.toContainText('testuser@example.com', { timeout: 10000 });
  });

  test('should enable public share link, export valid ICS feed, regenerate link, and revoke public link', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Open share dialog for the first calendar
    const shareBtn = page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]');
    await shareBtn.click();
    await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();

    const publicEnableCheckbox = page.locator('#public-link-enable');
    const publicArea = page.locator('#public-link-area');
    const publicInput = page.locator('#public-link-input');

    // 1. Enable public link if not already enabled
    const isChecked = await publicEnableCheckbox.isChecked();
    if (!isChecked) {
      await publicEnableCheckbox.click();
    }
    await expect(publicArea).not.toHaveClass(/hidden/, { timeout: 10000 });

    // 2. Extract public ICS share URL
    const publicUrl = await publicInput.inputValue();
    expect(publicUrl).toContain('/api/public/calendars/share/');
    expect(publicUrl).toContain('.ics');

    // 3. Fetch ICS feed via HTTP GET and verify contents
    const icsResponse = await request.get(publicUrl);
    expect(icsResponse.status()).toBe(200);
    expect(icsResponse.headers()['content-type']).toContain('text/calendar');
    const icsText = await icsResponse.text();
    expect(icsText).toContain('BEGIN:VCALENDAR');
    expect(icsText).toContain('END:VCALENDAR');

    // 4. Regenerate link
    page.once('dialog', async dialog => {
      await dialog.accept();
    });
    await page.click('#public-link-regen-btn');

    // Wait for public input to update to new URL
    await page.waitForFunction(
      (oldUrl) => {
        const input = document.querySelector('#public-link-input');
        return input && input.value && input.value !== oldUrl;
      },
      publicUrl,
      { timeout: 10000 }
    );

    const newPublicUrl = await publicInput.inputValue();
    expect(newPublicUrl).not.toBe(publicUrl);
    expect(newPublicUrl).toContain('/api/public/calendars/share/');

    // 5. Verify regenerated link fetches valid ICS
    const newIcsRes = await request.get(newPublicUrl);
    expect(newIcsRes.status()).toBe(200);

    // 6. Disable/revoke public link
    await publicEnableCheckbox.click();
    await expect(publicArea).toHaveClass(/hidden/);

    // 7. Verify old and new public links return 404
    const deadRes1 = await request.get(publicUrl);
    expect(deadRes1.status()).toBe(404);
    const deadRes2 = await request.get(newPublicUrl);
    expect(deadRes2.status()).toBe(404);
  });

  test('should create an event with a VALARM reminder and edit alarm setting', async ({ page }) => {
    await page.goto('/?date=2026-07-06');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Open create modal
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    const title = `VALARM Reminder Event ${Date.now()}`;
    await page.fill('#ev-title', title);

    // Select 15 minutes before alarm
    await page.selectOption('#ev-alarm', '-PT15M');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // Verify event chip appears
    const chip = page.locator(`.event-chip:has-text("${title}")`).first();
    await expect(chip).toBeVisible({ timeout: 10000 });

    // Click popover and edit
    await chip.click();
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    // Verify ev-alarm selected value is -PT15M
    const alarmVal = await page.locator('#ev-alarm').inputValue();
    expect(alarmVal).toBe('-PT15M');

    // Update alarm to 1 hour before
    await page.selectOption('#ev-alarm', '-PT1H');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // Clean up test 9 event
    await chip.click();
    page.on('dialog', dialog => dialog.accept());
    await page.click('#popover-delete-btn');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
  });


  test('should trigger desktop push notification and UI toast displaying event title, time, and location when VALARM is due', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.waitForFunction(() => !!window.__appStore);

    // Mock HTML5 Notification API in page context
    await page.evaluate(() => {
      window.desktopNotifications = [];
      window.Notification = class {
        constructor(title, options) {
          window.desktopNotifications.push({ title, options });
        }
        static permission = 'granted';
        static requestPermission() {
          return Promise.resolve('granted');
        }
      };
    });

    // Inject event into store and trigger checkAndTriggerAlarms
    const title = `Push Reminder ${Date.now()}`;
    const location = 'Conference Room B';

    await page.evaluate(({ title, location }) => {
      const store = window.__appStore;
      const events = store.get('events') || [];
      const now = new Date().toISOString();
      events.push({
        uid: `valarm-e2e-${Date.now()}`,
        title,
        location,
        start: now,
        end: now,
        alarms: [{ action: 'DISPLAY', trigger: 'PT0S', description: 'Erinnerungssitzung' }]
      });
      store.set({ events });
      if (typeof window.__checkAndTriggerAlarms === 'function') {
        window.__checkAndTriggerAlarms();
      }
    }, { title, location });

    // Verify UI Toast appears displaying title, time, and location
    const alarmToast = page.locator('#toast-container .toast', { hasText: title });
    await expect(alarmToast).toBeVisible({ timeout: 5000 });
    await expect(alarmToast).toContainText('Ort: Conference Room B');

    // Verify mock Notification API received desktop push notification
    const notifications = await page.evaluate(() => window.desktopNotifications);
    const targetNotif = notifications.find(n => n.title && n.title.includes(title));
    expect(targetNotif).toBeTruthy();
    expect(targetNotif.options.body).toContain('Ort: Conference Room B');
  });


  test('should create a VTODO task with RRULE, view in sidebar and Kanban board, and complete it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Open task create modal
    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });

    const taskTitle = `E2E VTODO Task ${Date.now()}`;
    await page.fill('#task-title', taskTitle);
    await page.fill('#task-description', 'Testing VTODO Kanban and RRULE advancement');
    await page.selectOption('#task-priority', '1');
    await page.selectOption('#task-recurrence', 'FREQ=WEEKLY');

    // Save task
    await page.click('#task-save-btn');
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/);

    // Verify task is listed in sidebar tasks section
    const sidebarList = page.locator('#sidebar-task-list');
    await expect(sidebarList).toContainText(taskTitle, { timeout: 10000 });

    // Switch to Kanban View
    await page.click('#view-kanban');
    await expect(page.locator('.kanban-board')).toBeVisible();

    // Verify task card appears in 'Zu erledigen' column
    const card = page.locator(`.kanban-card:has-text("${taskTitle}")`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('Hoch');
    await expect(card).toContainText('FREQ=WEEKLY');

    // Move task to 'In Bearbeitung' via ➡️
    await card.locator('.btn-status-next').click();
    const cardInProcess = page.locator('#kanban-cards-in-process .kanban-card', { hasText: taskTitle });
    await expect(cardInProcess).toBeVisible({ timeout: 10000 });

    // Complete recurring task via ✓ -> should advance next due date and reset to 'Zu erledigen'
    await cardInProcess.locator('.btn-complete').click();
    const cardResetted = page.locator('#kanban-cards-todo .kanban-card', { hasText: taskTitle });
    await expect(cardResetted).toBeVisible({ timeout: 10000 });

    // Clean up: delete task
    page.on('dialog', dialog => dialog.accept());
    await cardResetted.locator('.btn-delete').click();
    await expect(page.locator(`.kanban-card:has-text("${taskTitle}")`)).not.toBeVisible({ timeout: 10000 });
  });

  test('should open invitations modal and inspect iTIP/RSVP inbox', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#invitations-btn')).toBeVisible({ timeout: 10000 });

    // Open invitations modal
    await page.click('#invitations-btn');
    await expect(page.locator('#invitations-modal-backdrop')).not.toHaveClass(/hidden/);

    // Verify modal header title
    await expect(page.locator('#invitations-modal .modal-title')).toContainText('Einladungen');

    // Close invitations modal
    await page.click('#invitations-modal-close');
    await expect(page.locator('#invitations-modal-backdrop')).toHaveClass(/hidden/);
  });

  test('should trigger PDF vector export download via export-pdf-btn', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#export-pdf-btn')).toBeVisible({ timeout: 10000 });

    const downloadPromise = page.waitForEvent('download');
    await page.click('#export-pdf-btn');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('should enable secondary timezone dual grid and update hour labels in week view', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Open settings drawer
    await page.click('#sidebar-settings-btn');
    await expect(page.locator('#settings-drawer')).toHaveClass(/open/);

    // Toggle secondary timezone checkbox
    await page.check('#show-secondary-tz-toggle');

    // Select secondary timezone to New York
    await page.selectOption('#secondary-tz-select', 'America/New_York');

    // Close settings drawer
    await page.click('#close-settings-btn');
    await expect(page.locator('#settings-drawer')).not.toHaveClass(/open/);

    // Switch to Week view
    await page.click('#view-week');

    // Verify dual timezone gutter header and dual hour labels exist
    const gutter = page.locator('.week-time-gutter.dual-tz-gutter');
    await expect(gutter).toBeVisible({ timeout: 5000 });

    const dualLabels = page.locator('.week-hour-label.dual-tz');
    await expect(dualLabels.first()).toBeVisible({ timeout: 5000 });
  });

  test('should open availability booking modal, create a booking page, navigate to public booking link, and book a free slot', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Open availability booking modal
    await page.click('#availability-btn');
    await expect(page.locator('#availability-modal-backdrop')).not.toHaveClass(/hidden/);

    const slug = `e2e-slot-${Date.now()}`;
    await page.fill('#ap-title', 'E2E Public Consultation');
    await page.fill('#ap-slug', slug);
    await page.click('#ap-save-btn');

    // Verify created page appears in list
    const pageCard = page.locator(`.availability-page-card:has-text("${slug}")`);
    await expect(pageCard).toBeVisible({ timeout: 10000 });

    // Navigate to public booking page
    await page.goto(`/booking.html?slug=${slug}`);
    await expect(page.locator('#page-title')).toHaveText('E2E Public Consultation', { timeout: 10000 });

    // Select first slot
    const slotBtn = page.locator('.slot-btn').first();
    await expect(slotBtn).toBeVisible({ timeout: 10000 });
    await slotBtn.click();

    // Fill guest booking form
    await expect(page.locator('#booking-form-wrapper')).not.toHaveClass(/hidden/);
    await page.fill('#guest-name', 'Test User Guest');
    await page.fill('#guest-email', 'testuser@example.com');
    await page.fill('#guest-notes', 'E2E public booking test notes');

    // Submit booking
    await page.click('#confirm-booking-btn');

    // Confirmation box should appear
    await expect(page.locator('#booking-success')).not.toHaveClass(/hidden/, { timeout: 10000 });
  });

  test('should create an event with attachment drive link and display attachment link in popover', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    const title = `E2E Drive Attachment Event ${Date.now()}`;
    const driveUrl = 'https://files.freeshard.local/d/e2e-project-brief.pdf';
    const driveFileName = 'e2e-project-brief.pdf';

    // Click quick add or new event button
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    await page.fill('#ev-title', title);
    await page.fill('#ev-attachment-url', driveUrl);
    await page.fill('#ev-attachment-name', driveFileName);

    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });

    // Click the newly created event block
    const eventBlock = page.locator(`.event-chip:has-text("${title}"), .event-block:has-text("${title}")`).first();
    await expect(eventBlock).toBeVisible({ timeout: 10000 });
    await eventBlock.click();

    // Verify popover displays attachment link
    const attachmentLink = page.locator('.attachment-drive-link');
    await expect(attachmentLink).toBeVisible({ timeout: 5000 });
    await expect(attachmentLink).toHaveAttribute('href', driveUrl);
    await expect(attachmentLink).toHaveText(driveFileName);
  });

});





