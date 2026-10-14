'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

describe('Issue #226 — Failed Event Load Toolbar & Internal Date Synchronization', () => {
  test('static audit: loadEvents catch block invokes renderCalendarView() for in-sequence requests', () => {
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');
    const loadEventsMatch = appJsContent.match(/async\s+function\s+loadEvents\(\)[\s\S]*?(?=async\s+function\s+loadTasks)/);
    assert.ok(loadEventsMatch, 'loadEvents function body must exist in app.js');

    const loadEventsFn = loadEventsMatch[0];
    const catchBlockMatch = loadEventsFn.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*finally/);
    assert.ok(catchBlockMatch, 'catch block must exist in loadEvents');

    const catchContent = catchBlockMatch[1];
    assert.ok(
      catchContent.includes('renderCalendarView()'),
      'loadEvents catch block must invoke renderCalendarView() so toolbar title and view remain in sync with currentDate on fetch errors'
    );
  });

  test('functional simulation: failed event load updates toolbar-title to match currentDate', async () => {
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');
    const loadEventsMatch = appJsContent.match(/let\s+loadEventsSeq[\s\S]*?async\s+function\s+loadEvents\(\)[\s\S]*?\n\}/);
    assert.ok(loadEventsMatch, 'loadEvents block must exist in app.js');

    // Minimal state & DOM mock
    const mockState = {
      view: 'month',
      currentDate: new Date(2026, 1, 15), // February 15, 2026
      events: [],
      loadingEvents: false,
      searchQuery: ''
    };

    const mockStore = {
      get: (key) => mockState[key],
      set: (obj) => Object.assign(mockState, obj)
    };

    let renderCalendarViewCalled = false;
    let toolbarTitleText = 'Januar 2026'; // Stale title from previous month

    const mockDom = {
      'toolbar-title': { textContent: toolbarTitleText },
      'calendar-container': { innerHTML: '', appendChild: () => {} }
    };

    const mockDollar = (id) => mockDom[id] || { textContent: '', innerHTML: '', setAttribute: () => {} };

    let toastMessage = '';
    const mockShowToast = (msg) => { toastMessage = msg; };
    const mockSetStatus = () => {};
    const mockAnnounce = () => {};

    const mockGetDateRange = () => ({
      start: new Date(2026, 1, 1),
      end: new Date(2026, 1, 28)
    });

    const mockGetCachedEvents = () => null;
    const mockCacheEvents = () => {};

    const mockEventsAPI = {
      list: async () => {
        throw new Error('Simulated network error 500');
      }
    };

    const mockRenderCalendarView = () => {
      renderCalendarViewCalled = true;
      const view = mockStore.get('view');
      const date = mockStore.get('currentDate');
      // Mirror app.js renderCalendarView toolbar title update
      const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
      mockDollar('toolbar-title').textContent = `${months[date.getMonth()]} ${date.getFullYear()}`;
    };

    // Execute loadEvents within mocked environment
    const testFn = new Function(
      'store', 'EventsAPI', 'getDateRange', 'getCachedEvents', 'cacheEvents',
      'renderCalendarView', 'showToast', 'setStatus', 'announce', '$', 'webcalEvents', 'hiddenWebcal', 'loadWebcalEvents',
      'calendarsUnchanged', 'invalidateEventCache', 'loadCalendars',
      `
      ${loadEventsMatch[0]}
      return loadEvents();
      `
    );

    await testFn(
      mockStore, mockEventsAPI, mockGetDateRange, mockGetCachedEvents, mockCacheEvents,
      mockRenderCalendarView, mockShowToast, mockSetStatus, mockAnnounce, mockDollar, [], new Set(), async () => [],
      async () => false, () => {}, () => {} // delta check reports a change: full fetch (#170)
    );

    assert.ok(renderCalendarViewCalled, 'renderCalendarView must be called in loadEvents catch block');
    assert.strictEqual(mockDollar('toolbar-title').textContent, 'Februar 2026', 'toolbar-title must update to match currentDate ("Februar 2026") on failed fetch');
    assert.ok(toastMessage.includes('Simulated network error 500'), 'Toast error message must be shown');
  });
});
