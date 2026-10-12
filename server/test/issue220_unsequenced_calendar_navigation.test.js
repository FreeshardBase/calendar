'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

test('Issue #220 — Every Calendar Navigation Is an Unsequenced Write', async (t) => {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  await t.test('app.js maintains a sequence counter for loadEvents requests', () => {
    assert.ok(
      /loadEventsSeq|eventsReqSeq|loadSeq/.test(appJsContent),
      'app.js must maintain a sequence counter (e.g. loadEventsSeq) for loadEvents calls'
    );
  });

  await t.test('loadEvents verifies request sequence before caching and setting store events', () => {
    const loadEventsFnMatch = appJsContent.match(/async\s+function\s+loadEvents[\s\S]*?(?=async\s+function\s+loadTasks)/);
    assert.ok(loadEventsFnMatch, 'loadEvents function body must exist in app.js');
    const loadEventsFn = loadEventsFnMatch[0];

    assert.ok(
      /seq\s*!==\s*loadEventsSeq|loadEventsSeq\s*!==\s*seq|seq\s*!==\s*eventsReqSeq/.test(loadEventsFn),
      'loadEvents must verify request sequence (e.g. seq !== loadEventsSeq) before updating store or cache'
    );
  });

  await t.test('loadEvents updates loading state in finally block only for the latest request', () => {
    const loadEventsFnMatch = appJsContent.match(/async\s+function\s+loadEvents[\s\S]*?(?=async\s+function\s+loadTasks)/);
    assert.ok(loadEventsFnMatch, 'loadEvents function body must exist in app.js');
    const loadEventsFn = loadEventsFnMatch[0];

    assert.ok(
      /finally\s*\{[\s\S]*?(seq\s*===\s*loadEventsSeq|seq\s*===\s*eventsReqSeq)/.test(loadEventsFn),
      'loadEvents finally block must verify seq === loadEventsSeq before clearing loading state'
    );
  });

  await t.test('functional simulation: reordered navigation responses discard stale event lists', async () => {
    let mockEventsInStore = [];
    let renderCount = 0;
    let loadingState = false;

    const mockStore = {
      state: {
        view: 'month',
        currentDate: new Date('2026-03-01T00:00:00.000Z'),
        events: []
      },
      get(key) {
        return this.state[key];
      },
      set(obj) {
        Object.assign(this.state, obj);
        if ('events' in obj) mockEventsInStore = obj.events;
        if ('loadingEvents' in obj) loadingState = obj.loadingEvents;
      }
    };

    let req1Resolver = null;
    let req2Resolver = null;

    const mockEventsAPI = {
      list: (startStr, endStr) => {
        if (startStr.includes('2026-03')) {
          return new Promise(resolve => { req1Resolver = resolve; });
        } else {
          return new Promise(resolve => { req2Resolver = resolve; });
        }
      }
    };

    const loadEventsFnMatch = appJsContent.match(/let\s+loadEventsSeq[\s\S]*?async\s+function\s+loadEvents\(\)[\s\S]*?\n\}/);
    assert.ok(loadEventsFnMatch, 'loadEvents and loadEventsSeq declaration block must exist in app.js');

    const runner = new Function(
      'store',
      'EventsAPI',
      'getDateRange',
      'getCachedEvents',
      'cacheEvents',
      'renderCalendarView',
      'checkAndTriggerAlarms',
      'announce',
      'showToast',
      'setStatus',
      'webcalEvents',
      'hiddenWebcal',
      'loadWebcalEvents',
      `
      ${loadEventsFnMatch[0]}
      return loadEvents;
      `
    );

    const mockGetDateRange = (view, date) => {
      const dStr = date.toISOString().substring(0, 7);
      return {
        start: new Date(`${dStr}-01T00:00:00.000Z`),
        end: new Date(`${dStr}-28T23:59:59.999Z`)
      };
    };

    const loadEventsInstance = runner(
      mockStore,
      mockEventsAPI,
      mockGetDateRange,
      () => null, // no cache
      () => {},
      () => { renderCount++; },
      () => {},
      () => {},
      () => {},
      () => {},
      [],
      new Set(),
      async () => []
    );

    // 1. Navigation 1 (March 2026): req1 triggered
    mockStore.set({ currentDate: new Date('2026-03-01T00:00:00.000Z') });
    const p1 = loadEventsInstance();

    // 2. Navigation 2 (April 2026): req2 triggered immediately after
    mockStore.set({ currentDate: new Date('2026-04-01T00:00:00.000Z') });
    const p2 = loadEventsInstance();

    // 3. Req2 (April) resolves FIRST with April events
    const aprilEvents = [{ id: 'evt-april-1', title: 'April Event' }];
    req2Resolver(aprilEvents);
    await p2;

    assert.deepEqual(mockEventsInStore, aprilEvents, 'Store should hold April events after req2 resolution');
    assert.equal(loadingState, false, 'loadingEvents should be false after req2 completes');
    const rendersAfterReq2 = renderCount;

    // 4. Req1 (March) resolves SECOND (out-of-order response) with March events
    const marchEvents = [{ id: 'evt-march-1', title: 'March Event' }];
    req1Resolver(marchEvents);
    await p1;

    // Stale March response MUST be discarded!
    assert.deepEqual(mockEventsInStore, aprilEvents, 'Stale March response MUST NOT overwrite store events');
    assert.equal(renderCount, rendersAfterReq2, 'Stale March response MUST NOT trigger renderCalendarView()');
  });
});
