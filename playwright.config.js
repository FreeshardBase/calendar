const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3098',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: process.env.TZ || 'Europe/Berlin',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'PORT=3098 NODE_ENV=production SESSION_SECRET="e2e-playwright-test-session-secret-key-32bytes!" E2E_TEST=true INTERNAL_CALDAV_URL="https://localhost:5232" NODE_TLS_REJECT_UNAUTHORIZED="0" UNDICI_NO_AUTO_SELECT_FAMILY="1" SSL_KEY_PATH="" SSL_CERT_PATH="" SYSTEM_SYNC_SECRET="super-secret-bypass" node server/index.js',
    url: 'http://localhost:3098',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
