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
// Issue #340: production requires BASE_URL; the CSRF guard accepts only this origin.
const E2E_BASE_URL = process.env.BASE_URL || 'http://localhost:3098';
// Issue #246: production env mode serves only requests carrying the platform proxy's secret.
// The browser and the `request` fixture play the proxy by sending it on every request.
const E2E_PROXY_SECRET = 'e2e-playwright-proxy-secret-0123456789abcdef';

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalTeardown: './e2e/global-teardown.js',
  use: {
    baseURL: E2E_BASE_URL,
    // Issue #143: the proxy also renders the client type; a paired terminal is "terminal".
    extraHTTPHeaders: { 'X-Freeshard-Secret': E2E_PROXY_SECRET, 'X-Ptl-Client-Type': 'terminal' },
    ignoreHTTPSErrors: true,
    // #357: the service worker cannot register here: Chromium fetches /sw.js from the worker
    // target, which extraHTTPHeaders do not reach, so the proxy-secret gate answers 401 (the real
    // platform proxy adds the header to every request). Each such failed registration races the
    // test's own network events, and on a slow host Playwright then aborts the test with "Object
    // with guid response@… was not bound in the connection" or "Target page … has been closed".
    // So it is blocked for all specs; only the #571 describe runs it, in its own context behind a
    // forward proxy that adds the header to every request, as the platform proxy does.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Issue #239: the browser zone is a literal, not the ambient TZ, and differs from the server's
    // (webServer.env.TZ below); otherwise every clock assertion in the suite passes vacuously.
    timezoneId: 'Europe/Berlin',
    locale: 'de-DE',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // #574: drag and drop on a phone (touch, long press); #351: the phone layout at 412×915.
    {
      name: 'mobile-touch',
      testMatch: /(dragdrop|issue351_mobile_layout)\.spec\.js/,
      use: { ...devices['Pixel 7'] },
    },
    // #351: the phone layout at 375×667, an iPhone's screen and touch emulated in Chromium.
    {
      name: 'mobile-iphone',
      testMatch: /issue351_mobile_layout\.spec\.js/,
      use: { ...devices['iPhone 8'], defaultBrowserType: 'chromium' },
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
      // Issue #239: pinned, and different from the browser's `use.timezoneId`.
      TZ: 'UTC',
      PORT: '3098',
      NODE_ENV: 'production',
      BASE_URL: E2E_BASE_URL,
      DATABASE_PATH: E2E_DATABASE_PATH,
      CALDAV_USERNAME: E2E_USER,
      SESSION_SECRET: 'e2e-playwright-test-session-secret-key-32bytes!',
      ENCRYPTION_KEY: 'e2e-playwright-encryption-key-32bytes!',
      HTTP_HEADER_AUTH_SECRET: E2E_PROXY_SECRET,
      // Issue #592: the proxy's identity header names the user, so each test (e2e/fixtures.js) signs in
      // as its own user with its own principal and never sees another test's events or calendars.
      HTTP_HEADER_AUTH: 'true',
      INTERNAL_CALDAV_URL: 'https://localhost:5232',
      UNDICI_NO_AUTO_SELECT_FAMILY: '1',
      SSL_KEY_PATH: '',
      SSL_CERT_PATH: '',
      SYSTEM_SYNC_SECRET: 'super-secret-bypass',
      ALLOW_INSECURE_SYSTEM_SYNC_SECRET: 'true',
      OUTBOUND_FETCH_ALLOW_HOSTS: '127.0.0.1',
      // #97: a placeholder Azure app id, so the Microsoft 365 connect flow is offered. The specs only
      // inspect the redirect to Microsoft; no browser navigation or request reaches it.
      MSGRAPH_CLIENT_ID: '00000000-0000-0000-0000-0000000e2e97',
      // #513: the weather spec serves a Bright Sky stand-in on this loopback port; the shipping
      // default is the public https://api.brightsky.dev.
      WEATHER_BRIGHTSKY_URL: 'http://127.0.0.1:3713',
      // #512: the address lookup and map tile services, played by e2e/issue512_location_lookup.spec.js
      // on loopback, so the specs can see exactly which requests leave the shard.
      GEOCODER_PHOTON_URL: 'http://127.0.0.1:3514',
      OSM_TILE_URL: 'http://127.0.0.1:3514/tiles',
    },
    url: 'http://localhost:3098',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
