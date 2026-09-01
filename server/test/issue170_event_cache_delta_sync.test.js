'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #170 — Client Event Cache & Delta Sync Engine', async (t) => {
  const storeJsPath = path.resolve(__dirname, '../../public/js/store.js');
  const appJsPath = path.resolve(__dirname, '../../public/js/app.js');
  const apiJsPath = path.resolve(__dirname, '../../public/js/api.js');

  const storeJsContent = fs.readFileSync(storeJsPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  const apiJsContent = fs.readFileSync(apiJsPath, 'utf8');

  await t.test('public/js/store.js exports event caching and delta sync functions', () => {
    assert.ok(storeJsContent.includes('export function cacheEvents'), 'store.js must export cacheEvents');
    assert.ok(storeJsContent.includes('export function getCachedEvents'), 'store.js must export getCachedEvents');
    assert.ok(storeJsContent.includes('export function invalidateEventCache'), 'store.js must export invalidateEventCache');
    assert.ok(storeJsContent.includes('export function setCalendarSyncCache'), 'store.js must export setCalendarSyncCache');
    assert.ok(storeJsContent.includes('export function getCalendarSyncCache'), 'store.js must export getCalendarSyncCache');
  });

  await t.test('public/js/app.js imports and utilizes client event cache in loadEvents()', () => {
    assert.ok(appJsContent.includes('getCachedEvents'), 'app.js must import and call getCachedEvents');
    assert.ok(appJsContent.includes('cacheEvents'), 'app.js must import and call cacheEvents');
    assert.ok(appJsContent.includes('const cached = getCachedEvents'), 'loadEvents in app.js must check getCachedEvents before network fetch');
  });

  await t.test('public/js/app.js implements deltaSync helper using getCalendarSyncCache and setCalendarSyncCache', () => {
    assert.ok(appJsContent.includes('syncCalendarDelta') || appJsContent.includes('CalendarsAPI.deltaSync'), 'app.js must support delta sync via CalendarsAPI.deltaSync');
    assert.ok(appJsContent.includes('getCalendarSyncCache'), 'app.js must check cached sync token via getCalendarSyncCache');
    assert.ok(appJsContent.includes('setCalendarSyncCache'), 'app.js must store returned sync token via setCalendarSyncCache');
  });

  await t.test('public/js/api.js defines deltaSync endpoint', () => {
    assert.ok(apiJsContent.includes('deltaSync:'), 'api.js must define deltaSync endpoint for calendars');
  });
});
