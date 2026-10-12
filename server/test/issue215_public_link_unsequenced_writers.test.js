'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJsPath = path.resolve(__dirname, '../../public/js/app.js');

test('Issue #215 — Public Link Dialog Unsequenced Writers & Out-Of-Order Response Protection', async (t) => {
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  await t.test('app.js includes sequence counter tracking for public link async operations', () => {
    assert.ok(
      /publicLinkSeq|shareLinkSeq|publicReqSeq/.test(appJsContent),
      'app.js must maintain a sequence counter (e.g. publicLinkSeq) in openShareDialog'
    );
  });

  await t.test('loadPublicLink checks request sequence before updating DOM elements', () => {
    const loadPublicFnMatch = appJsContent.match(/async\s+function\s+loadPublicLink[\s\S]*?\n\s*\}/);
    assert.ok(loadPublicFnMatch, 'loadPublicLink function body must exist');
    const loadPublicFn = loadPublicFnMatch[0];

    assert.ok(
      /seq\s*!==\s*publicLinkSeq|publicLinkSeq\s*!==\s*seq/.test(loadPublicFn),
      'loadPublicLink must verify request sequence before modifying publicEnable or publicInput'
    );
  });

  await t.test('publicEnable change listener checks request sequence before updating DOM elements or reverting state on error', () => {
    const changeListenerMatch = appJsContent.match(/publicEnable\.addEventListener\('change'[\s\S]*?\n\s*\}\);/);
    assert.ok(changeListenerMatch, 'publicEnable change listener must exist');
    const changeListener = changeListenerMatch[0];

    assert.ok(
      /seq\s*!==\s*publicLinkSeq|publicLinkSeq\s*!==\s*seq/.test(changeListener),
      'publicEnable change listener must verify request sequence before modifying publicArea or publicInput or reverting checkbox on error'
    );
  });

  await t.test('publicRegen click listener checks request sequence before updating DOM elements', () => {
    const regenListenerMatch = appJsContent.match(/publicRegen\.addEventListener\('click'[\s\S]*?\n\s*\}\);/);
    assert.ok(regenListenerMatch, 'publicRegen click listener must exist');
    const regenListener = regenListenerMatch[0];

    assert.ok(
      /seq\s*!==\s*publicLinkSeq|publicLinkSeq\s*!==\s*seq/.test(regenListener),
      'publicRegen click listener must verify request sequence before modifying publicInput'
    );
  });

  await t.test('functional simulation: reordered responses discard stale getPublicLink resolution', async () => {
    let mockPublicEnableChecked = false;
    let mockPublicAreaHidden = true;
    let mockPublicInputValue = '';

    const mockPublicEnable = {
      get checked() { return mockPublicEnableChecked; },
      set checked(val) { mockPublicEnableChecked = val; },
      addEventListener(evt, fn) { this._handler = fn; }
    };
    const mockPublicArea = {
      classList: {
        remove(cls) { if (cls === 'hidden') mockPublicAreaHidden = false; },
        add(cls) { if (cls === 'hidden') mockPublicAreaHidden = true; }
      }
    };
    const mockPublicInput = {
      get value() { return mockPublicInputValue; },
      set value(val) { mockPublicInputValue = val; }
    };
    const mockPublicCopy = {
      addEventListener(evt, fn) { this._handler = fn; }
    };
    const mockPublicRegen = {
      addEventListener(evt, fn) { this._handler = fn; }
    };
    // #341: detail-level selector shown alongside the link
    const mockPublicDetail = {
      value: 'busy',
      addEventListener(evt, fn) { this._handler = fn; }
    };
    const mockPublicDetailGroup = { classList: { remove() {}, add() {} } };

    // Extract the public link handling logic inside openShareDialog from app.js
    const shareDialogSectionMatch = appJsContent.match(/let\s+publicLinkSeq[\s\S]*?loadPublicLink\(\);/);
    assert.ok(shareDialogSectionMatch, 'public link handling section with loadPublicLink() must exist in app.js');

    let getPublicLinkResolver = null;
    let enablePublicLinkResolver = null;

    const mockCalendarsAPI = {
      getPublicLink: () => new Promise((resolve) => { getPublicLinkResolver = resolve; }),
      enablePublicLink: () => new Promise((resolve) => { enablePublicLinkResolver = resolve; }),
      disablePublicLink: () => Promise.resolve()
    };

    const mockShowToast = () => {};

    const runner = new Function(
      'publicEnable',
      'publicArea',
      'publicInput',
      'publicCopy',
      'publicRegen',
      'publicDetail',
      'publicDetailGroup',
      'CalendarsAPI',
      'showToast',
      'cal',
      `
      ${shareDialogSectionMatch[0]}
      return { loadPublicLink, fireEnableChange: () => publicEnable._handler() };
      `
    );

    const instance = runner(
      mockPublicEnable,
      mockPublicArea,
      mockPublicInput,
      mockPublicCopy,
      mockPublicRegen,
      mockPublicDetail,
      mockPublicDetailGroup,
      mockCalendarsAPI,
      mockShowToast,
      { id: 'cal-123' }
    );

    // 1. loadPublicLink triggered (seq = 1, getPublicLink pending)
    // 2. User checks publicEnable (seq = 2, enablePublicLink pending)
    mockPublicEnableChecked = true;
    const enablePromise = instance.fireEnableChange();

    // 3. Request 2 (enablePublicLink) resolves FIRST with new live link
    enablePublicLinkResolver({ enabled: true, url: 'http://example.com/live-share.ics', detail: 'busy' });
    await enablePromise;

    assert.equal(mockPublicEnableChecked, true, 'publicEnable.checked should be true after enable resolution');
    assert.equal(mockPublicAreaHidden, false, 'publicArea should not be hidden after enable resolution');
    assert.equal(mockPublicInputValue, 'http://example.com/live-share.ics', 'publicInput.value should be live share URL');

    // 4. Request 1 (getPublicLink) resolves SECOND with stale disabled state
    getPublicLinkResolver({ enabled: false, url: '' });
    // Allow any microtasks to run
    await new Promise(r => setTimeout(r, 10));

    // Stale getPublicLink resolution must be IGNORED
    assert.equal(mockPublicEnableChecked, true, 'Stale getPublicLink resolution MUST NOT uncheck publicEnable');
    assert.equal(mockPublicAreaHidden, false, 'Stale getPublicLink resolution MUST NOT hide publicArea');
    assert.equal(mockPublicInputValue, 'http://example.com/live-share.ics', 'Stale getPublicLink resolution MUST NOT overwrite publicInput.value');
  });
});
