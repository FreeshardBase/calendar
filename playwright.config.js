const { defineConfig, devices } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The suite's fixture data goes into its own database, never into the developer's webcalendar.db.
const E2E_DATABASE_PATH = path.join(os.tmpdir(), 'webcalendar-e2e', 'webcalendar.db');
fs.mkdirSync(path.dirname(E2E_DATABASE_PATH), { recursive: true });

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
  // Issue #211: the server under test runs the shipping configuration (docker-compose.yml:
  // NODE_ENV=production, own DATABASE_PATH) with no test-mode switch, so auth specs probe the
  // guards that ship. Two deliberate deviations, both operator settings production also honours:
  // ALLOW_INSECURE_SYSTEM_SYNC_SECRET, because the CI Radicale (.github/workflows/ci.yml) is started
  // with the legacy SYSTEM_SYNC_SECRET, and OUTBOUND_FETCH_ALLOW_HOSTS, so the webcal specs can
  // fetch feeds from their loopback HTTP servers. Neither touches request authentication.
  webServer: {
    command: 'node server/index.js',
    env: {
      PORT: '3098',
      NODE_ENV: 'production',
      DATABASE_PATH: E2E_DATABASE_PATH,
      SESSION_SECRET: 'e2e-playwright-test-session-secret-key-32bytes!',
      ENCRYPTION_KEY: 'e2e-playwright-encryption-key-32bytes!',
      INTERNAL_CALDAV_URL: 'https://localhost:5232',
      UNDICI_NO_AUTO_SELECT_FAMILY: '1',
      SSL_KEY_PATH: '',
      SSL_CERT_PATH: '',
      SYSTEM_SYNC_SECRET: 'super-secret-bypass',
      ALLOW_INSECURE_SYSTEM_SYNC_SECRET: 'true',
      OUTBOUND_FETCH_ALLOW_HOSTS: '127.0.0.1',
    },
    url: 'http://localhost:3098',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
