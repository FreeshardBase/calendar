const { defineConfig, devices } = require('@playwright/test');
const os = require('os');
const path = require('path');

// Issue #217: every run is its own fixture — a fresh database and a fresh CalDAV principal
// (/<E2E_USER>/ on Radicale), so specs never read another run's residue or the developer's data,
// and e2e/global-teardown.js drops both wholesale. The id is fixed once in the runner process;
// the workers inherit it through the environment and so resolve the same paths. The run directory
// is created by the webServer command, so merely loading this config leaves nothing behind.
process.env.E2E_RUN_ID = process.env.E2E_RUN_ID || `${Date.now().toString(36)}-${process.pid}`;
const E2E_USER = `e2e-${process.env.E2E_RUN_ID}`;
const E2E_RUN_DIR = path.join(os.tmpdir(), 'webcalendar-e2e', process.env.E2E_RUN_ID);
const E2E_DATABASE_PATH = path.join(E2E_RUN_DIR, 'webcalendar.db');

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalTeardown: './e2e/global-teardown.js',
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
    command: `mkdir -p '${E2E_RUN_DIR}' && node server/index.js`,
    env: {
      PORT: '3098',
      NODE_ENV: 'production',
      DATABASE_PATH: E2E_DATABASE_PATH,
      CALDAV_USERNAME: E2E_USER,
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
