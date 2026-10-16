'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const eventModalJsPath = path.resolve('public/js/eventModal.js');

test('Issue #185 — Form Controls Programmatic Labels & Password Reveal Accessible Name', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const eventModalJs = fs.readFileSync(eventModalJsPath, 'utf8');

  await t.test('index.html form controls have programmatic labels/aria-labels', () => {
    // 1. ev-title
    assert.ok(
      indexHtml.includes('id="ev-title"') && indexHtml.includes('aria-label="Titel des Termins"'),
      '#ev-title must have an accessible name / aria-label="Titel des Termins"'
    );
    // 2. search-input
    assert.ok(
      indexHtml.includes('id="search-input"') && indexHtml.includes('aria-label="Kalender durchsuchen"'),
      '#search-input must have an accessible name / aria-label="Kalender durchsuchen"'
    );
    // 3. recur-monthly-week-idx
    assert.ok(
      indexHtml.includes('id="recur-monthly-week-idx"') && indexHtml.includes('aria-label="Woche des Monats"'),
      '#recur-monthly-week-idx must have aria-label="Woche des Monats"'
    );
    // 4. recur-monthly-weekday
    assert.ok(
      indexHtml.includes('id="recur-monthly-weekday"') && indexHtml.includes('aria-label="Wochentag"'),
      '#recur-monthly-weekday must have aria-label="Wochentag"'
    );
    // 5. recur-end-date
    assert.ok(
      indexHtml.includes('id="recur-end-date"') && indexHtml.includes('aria-label="Enddatum der Wiederholung"'),
      '#recur-end-date must have aria-label="Enddatum der Wiederholung"'
    );
    // 6. recur-end-count
    assert.ok(
      indexHtml.includes('id="recur-end-count"') && indexHtml.includes('aria-label="Anzahl Wiederholungen"'),
      '#recur-end-count must have aria-label="Anzahl Wiederholungen"'
    );
    // 7. ev-attendee-name
    assert.ok(
      indexHtml.includes('id="ev-attendee-name"') && indexHtml.includes('aria-label="Name der teilnehmenden Person"'),
      '#ev-attendee-name must have aria-label="Name der teilnehmenden Person"'
    );
    // 8. ev-attendee-email
    assert.ok(
      indexHtml.includes('id="ev-attendee-email"') && indexHtml.includes('aria-label="E-Mail der teilnehmenden Person"'),
      '#ev-attendee-email must have aria-label="E-Mail der teilnehmenden Person"'
    );
  });

  await t.test('account dialog password-reveal button has accessible name in index.html', () => {
    const fullAccSnippet = indexHtml.substring(indexHtml.indexOf('data-target="acc-password"') - 100, indexHtml.indexOf('data-target="acc-password"') + 100);
    assert.ok(
      fullAccSnippet.includes('aria-label="Passwort anzeigen"'),
      'account dialog password toggle button must have aria-label="Passwort anzeigen"'
    );
  });

  await t.test('eventModal.js dynamically updates aria-label on password toggle click', () => {
    assert.ok(
      eventModalJs.includes("setAttribute('aria-label'") || eventModalJs.includes('setAttribute("aria-label"'),
      'eventModal.js must dynamically update aria-label attribute when password visibility is toggled'
    );
  });
});
