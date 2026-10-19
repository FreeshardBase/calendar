'use strict';

const base = require('@playwright/test');
const { webServer } = require('../playwright.config.js');
const { removePrincipal } = require('./global-teardown.js');

// Issue #592: every test is its own fixture. #217 gave each run a fresh database and principal,
// but ~220 tests then shared that one principal, so a test saw the events and calendars earlier
// tests left behind, and whether background reloads raced its assertions depended on which tests
// ran before. Now each test signs in as its own user through the platform proxy's identity header
// (HTTP_HEADER_AUTH, the shipping env-mode path), which the server maps to its own Radicale
// principal /<user>/ and its own database rows. The principal is dropped after the test.
let sequence = 0;

const test = base.test.extend({
  // The test's user id. Prefixed with the run user, so it stays an `e2e-…` fixture name that
  // removePrincipal accepts, and unique per worker and test. Playwright requires the first argument
  // to be an object pattern even when the fixture depends on nothing.
  // eslint-disable-next-line no-empty-pattern
  e2eUser: [async ({}, use, testInfo) => {
    sequence += 1;
    const user = `${webServer.env.CALDAV_USERNAME}-w${testInfo.workerIndex}-t${sequence}`;
    await use(user);
    await removePrincipal({
      caldavUrl: webServer.env.INTERNAL_CALDAV_URL,
      username: user,
      secret: webServer.env.SYSTEM_SYNC_SECRET,
    });
  }, { auto: true }],
  // Every context of the test (page, request, browser.newContext()) presents the test's user.
  extraHTTPHeaders: async ({ extraHTTPHeaders, e2eUser }, use) => {
    await use({ ...extraHTTPHeaders, 'X-Forwarded-User': e2eUser });
  },
});

module.exports = { test, expect: base.expect };
