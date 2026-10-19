'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3511';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

// #511: the export dialog's settings reach the renderer, and the preview is page 1 of the PDF.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExportOptions, generateCalendarPDF, renderPreview } = require('../utils/pdfExport');

const CALENDARS = [
  { id: 'testuser/work', name: 'Arbeit', color: '#d03030' },
  { id: 'testuser/home', name: 'Privat', color: '#2060c0' }
];
const EVENTS = [
  { calendarId: 'testuser/work', title: 'Planung Q4', start: '2026-10-13T09:00', end: '2026-10-13T10:30', description: 'Agenda durchgehen', location: 'Raum 2' },
  { calendarId: 'testuser/home', title: 'Zahnarzt', start: '2026-10-14T16:00', end: '2026-10-14T17:00', description: 'Versicherungskarte mitnehmen' },
  { calendarId: 'testuser/work', title: 'Messe', allDay: true, start: '2026-10-15', end: '2026-10-17' }
];

function opts(overrides = {}) {
  const { options, error } = parseExportOptions({
    view: 'list', from: '2026-10-12', to: '2026-10-18', paper: 'a4', orientation: 'portrait',
    descriptions: false, color: true, calendars: CALENDARS, events: EVENTS, ...overrides
  });
  assert.equal(error, undefined);
  return options;
}

function pdfPages(buf) {
  const pdf = buf.toString('latin1');
  const streams = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]);
  const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map(m => [Number(m[1]), Number(m[2])]);
  return { pdf, streams, boxes, count: Number(/\/Type \/Pages [^>]*\/Count (\d+)/.exec(pdf)[1]) };
}

const pdfTexts = (stream) => [...stream.matchAll(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) Td \(((?:\\.|[^\\)])*)\) Tj/g)]
  .map(m => ({ x: Number(m[1]), y: Number(m[2]), text: m[3].replace(/\\(.)/g, '$1') }));
const svgTexts = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
  .map(m => ({ x: Number(m[1]), y: Number(m[2]), text: m[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') }));

test('#511: the preview is page 1 of the PDF — the same texts at the same places, for every view', () => {
  for (const view of ['month', 'week', 'day', 'list']) {
    for (const [paper, orientation] of [['a4', 'landscape'], ['letter', 'portrait']]) {
      const o = opts({ view, paper, orientation, descriptions: true, from: '2026-10-13', to: '2026-10-20' });
      const preview = renderPreview(o);
      const { streams, boxes, count } = pdfPages(generateCalendarPDF(o));
      assert.equal(preview.pageCount, count, `${view}: the preview names the PDF's page count`);
      assert.deepEqual([preview.width, preview.height], boxes[0], `${view}: same page size`);
      const fromPdf = pdfTexts(streams[0]).map(t => ({ ...t, y: Number((boxes[0][1] - t.y).toFixed(2)) }));
      const fromSvg = svgTexts(preview.svg);
      assert.ok(fromSvg.length > 5, `${view}: the preview draws text`);
      assert.deepEqual(fromSvg, fromPdf, `${view} ${paper} ${orientation}: preview and PDF page 1 differ`);
    }
  }
});

test('#511: paper size and orientation set the page size of PDF and preview', () => {
  const cases = [
    ['a4', 'portrait', [595, 842]], ['a4', 'landscape', [842, 595]],
    ['letter', 'portrait', [612, 792]], ['letter', 'landscape', [792, 612]]
  ];
  for (const [paper, orientation, size] of cases) {
    const o = opts({ view: 'month', paper, orientation });
    assert.deepEqual(pdfPages(generateCalendarPDF(o)).boxes[0], size, `${paper} ${orientation}`);
    const p = renderPreview(o);
    assert.deepEqual([p.width, p.height], size);
    assert.match(p.svg, new RegExp(`width="${size[0]}" height="${size[1]}"`));
  }
  assert.ok(parseExportOptions({ ...opts(), from: '2026-10-12', to: '2026-10-18', calendars: CALENDARS, view: 'list', paper: 'a3' }).error);
  assert.ok(parseExportOptions({ from: '2026-10-12', to: '2026-10-18', calendars: CALENDARS, view: 'list', orientation: 'diagonal' }).error);
});

test('#511: the range decides the pages — one per month, week or day, and the list covers only the range', () => {
  assert.equal(pdfPages(generateCalendarPDF(opts({ view: 'month', from: '2026-10-20', to: '2026-12-02' }))).count, 3);
  assert.equal(pdfPages(generateCalendarPDF(opts({ view: 'week', from: '2026-10-12', to: '2026-10-26' }))).count, 3);
  assert.equal(pdfPages(generateCalendarPDF(opts({ view: 'day', from: '2026-10-13', to: '2026-10-16' }))).count, 4);

  const list = pdfPages(generateCalendarPDF(opts({ view: 'list', from: '2026-10-14', to: '2026-10-14' }))).pdf;
  assert.ok(list.includes('(Zahnarzt)'));
  assert.ok(!list.includes('(Planung Q4)'), 'an event outside the range is not listed');

  assert.ok(parseExportOptions({ view: 'list', from: '2026-10-18', to: '2026-10-12', calendars: CALENDARS }).error, 'end before start');
  assert.ok(parseExportOptions({ view: 'list', from: '2026-01-01', to: '2027-06-01', calendars: CALENDARS }).error, 'over a year');
  assert.ok(parseExportOptions({ view: 'list', calendars: CALENDARS }).error, 'no range');
});

test('#511: each view lays out its own page', () => {
  const week = renderPreview(opts({ view: 'week' })).svg;
  assert.match(week, />KW 42 · 12\.10\.2026 - 18\.10\.2026</);
  assert.match(week, />09:00<\/text>/, 'the week has an hour grid');
  const day = renderPreview(opts({ view: 'day', from: '2026-10-13', to: '2026-10-13' })).svg;
  assert.match(day, />Dienstag, 13\. Oktober 2026</);
  assert.match(day, />Planung Q4</);
  const month = renderPreview(opts({ view: 'month' })).svg;
  assert.match(month, />Oktober 2026</);
  assert.match(month, />31<\/text>/, 'the month grid numbers every day');
  const list = renderPreview(opts({ view: 'list' })).svg;
  assert.match(list, />Mittwoch, 14\. Oktober 2026</);
  assert.match(list, />16:00 - 17:00</);
  assert.ok(parseExportOptions({ view: 'agenda', from: '2026-10-12', to: '2026-10-18', calendars: CALENDARS }).error);
});

test('#511: only the chosen calendars are printed', () => {
  const both = generateCalendarPDF(opts()).toString('latin1');
  assert.ok(both.includes('(Zahnarzt)') && both.includes('(Planung Q4)'));
  const workOnly = generateCalendarPDF(opts({ calendars: [CALENDARS[0]] })).toString('latin1');
  assert.ok(workOnly.includes('(Planung Q4)'));
  assert.ok(!workOnly.includes('(Zahnarzt)'), 'an event of a calendar left out is not printed');
  assert.ok(!renderPreview(opts({ calendars: [CALENDARS[0]] })).svg.includes('Zahnarzt'));
});

test('#511: descriptions are printed only when asked for', () => {
  for (const view of ['list', 'day', 'week']) {
    const from = view === 'day' ? '2026-10-14' : '2026-10-12';
    const without = generateCalendarPDF(opts({ view, from, descriptions: false })).toString('latin1');
    const withDesc = generateCalendarPDF(opts({ view, from, descriptions: true })).toString('latin1');
    assert.ok(!without.includes('Versicherungs'), `${view}: no description by default`);
    assert.ok(withDesc.includes('Versicherungs'), `${view}: the description is printed when chosen`);
  }
});

test('#511: black and white prints only greys, colour prints the calendar colour', () => {
  const colours = (buf) => [...buf.toString('latin1').matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)].map(m => m.slice(1, 4).map(Number));
  for (const view of ['month', 'week', 'list']) {
    const bw = colours(generateCalendarPDF(opts({ view, color: false })));
    assert.ok(bw.length > 0);
    assert.ok(bw.every(([r, g, b]) => r === g && g === b), `${view}: black and white uses no colour`);
    const colour = colours(generateCalendarPDF(opts({ view, color: true })));
    assert.ok(colour.some(([r, g, b]) => r === 0.816 && g === 0.188 && b === 0.188), `${view}: the calendar colour #d03030 is printed`);
    assert.ok(!renderPreview(opts({ view, color: false })).svg.includes('rgb(208,48,48)'));
    assert.ok(renderPreview(opts({ view, color: true })).svg.includes('rgb(208,48,48)'));
  }
});

test('#511: event text cannot break out of the preview SVG or the PDF string', () => {
  const evil = [{ calendarId: 'testuser/work', title: '</text><script>alert(1)</script>) Tj (x', start: '2026-10-13T09:00', end: '2026-10-13T10:00' }];
  const svg = renderPreview(opts({ events: evil })).svg;
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;'));
  const pdf = generateCalendarPDF(opts({ events: evil })).toString('latin1');
  assert.ok(pdf.includes('\\) Tj \\(x'));
});

test('#511: POST /api/calendars/export/preview answers the first page as SVG with the page count', async (t) => {
  const { server } = require('../index');
  await new Promise(resolve => server.listen(process.env.PORT, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { loginAs } = require('./helpers/testSession');
  const cookie = await loginAs('testuser', { username: 'testuser', email: 'testuser@example.com' });
  const base = `http://localhost:${process.env.PORT}/api/calendars/export`;
  const body = { view: 'day', from: '2026-10-13', to: '2026-10-15', paper: 'letter', orientation: 'landscape', descriptions: true, color: true, calendars: CALENDARS, events: EVENTS };
  const post = (path, data, headers = { cookie }) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data)
  });

  const res = await post('preview', body);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(res.headers.get('x-export-pages'), '3');
  const svg = await res.text();
  assert.match(svg, /^<svg [^>]*width="792" height="612"/);
  assert.match(svg, /Agenda durchgehen/);

  const pdfRes = await post('pdf', body);
  assert.equal(pdfRes.status, 200);
  const pages = pdfPages(Buffer.from(await pdfRes.arrayBuffer()));
  assert.equal(pages.count, 3);
  assert.deepEqual(pdfTexts(pages.streams[0]).map(x => x.text), svgTexts(svg).map(x => x.text));

  const bad = await post('preview', { ...body, paper: 'a0' });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);
  assert.equal((await post('preview', body, {})).status, 401);
});
