'use strict';
// Issue #627: the PDF export (drawn by the server) speaks the UI language the client sends:
// English or German, with day and month names from Intl; Deutsch (Sie) prints as Deutsch (Du),
// and a request without a language stays German.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExportOptions, renderPreview } = require('../utils/pdfExport');

function preview(body) {
  const { options, error } = parseExportOptions({
    from: '2041-03-04', to: '2041-03-04', calendars: [{ id: 'cal-1', name: 'Test', color: '#3b82f6' }],
    events: [], ...body,
  });
  assert.equal(error, undefined);
  return renderPreview(options).svg;
}

test('Issue #627 — an English PDF has English headings, day names and page numbers', () => {
  const list = preview({ view: 'list', language: 'en' });
  assert.match(list, /No events in this period\./);
  assert.match(list, /Page 1 of 1/);
  assert.doesNotMatch(list, /Termine|Seite/);
  assert.match(preview({ view: 'day', language: 'en' }), /Monday, March 4, 2041/);
  const week = preview({ view: 'week', language: 'en' });
  assert.match(week, /Week 10/);
  assert.doesNotMatch(week, /KW|Di /);
  const month = preview({ view: 'month', language: 'en' });
  assert.match(month, /March 2041/);
  assert.match(month, />Mon</);
});

test('Issue #627 — German (Du and Sie, and no language at all) stays German', () => {
  for (const language of ['de', 'de-formal', undefined]) {
    const list = preview({ view: 'list', language });
    assert.match(list, /Keine Termine in diesem Zeitraum\./, String(language));
    assert.match(list, /Seite 1 von 1/);
    assert.match(preview({ view: 'day', language }), /Montag, 4\. März 2041/);
    assert.match(preview({ view: 'week', language }), /KW 10/);
    assert.match(preview({ view: 'month', language }), />Mo</);
  }
});

test('Issue #627 — an unknown language is refused', () => {
  assert.ok(parseExportOptions({ view: 'list', from: '2041-03-04', to: '2041-03-04', calendars: [], language: 'fr' }).error);
});
