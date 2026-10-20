/**
 * Calendar print renderer for FreeShard WebCalendar (#511).
 *
 * One layout pass turns the export settings into pages of drawing operations (rectangles, lines,
 * text) in points with the origin top left. Two back ends draw those pages: toPdf() writes a
 * PDF-1.4 file, toSvg() draws a single page as SVG for the preview in the export dialog. Since
 * both read the same operations, the preview shows exactly what the PDF prints.
 */

const PAPER = {
  a4: { width: 595, height: 842 },
  letter: { width: 612, height: 792 }
};
const VIEWS = ['month', 'week', 'day', 'list'];
const MAX_RANGE_DAYS = 366;
const MARGIN = 28;
const HEADER_HEIGHT = 44;
const FOOTER_HEIGHT = 18;

// #627: the PDF speaks the UI language the client sends ('de' when none is sent); names of days
// and months come from Intl in that language. Deutsch (Sie) prints the same as Deutsch (Du).
const LANGUAGES = { de: 'de', 'de-formal': 'de', en: 'en' };
const TEXT = {
  de: {
    week: n => `KW ${n}`,
    listHeading: range => `Termine ${range}`,
    allDay: 'ganztägig',
    noEvents: 'Keine Termine in diesem Zeitraum.',
    page: (i, n) => `Seite ${i} von ${n}`,
  },
  en: {
    week: n => `Week ${n}`,
    listHeading: range => `Events ${range}`,
    allDay: 'all day',
    noEvents: 'No events in this period.',
    page: (i, n) => `Page ${i} of ${n}`,
  },
};
const text = o => TEXT[LANGUAGES[o.language]];
const MONDAY = Date.UTC(2024, 0, 1);
const fmt = (o, opts) => new Intl.DateTimeFormat(LANGUAGES[o.language], { timeZone: 'UTC', ...opts });
const utc = n => new Date(Date.UTC(...ymdOf(n).split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))));
const weekdayShort = (o, idx) => fmt(o, { weekday: 'short' }).format(new Date(MONDAY + idx * 86400000)).replace(/\.$/, '');
const monthYear = (o, n) => fmt(o, { month: 'long', year: 'numeric' }).format(utc(n));

const INK = [0.12, 0.13, 0.15];
const MUTED = [0.45, 0.46, 0.5];
const RULE = [0.82, 0.83, 0.86];
const HEADER_FILL = [0.95, 0.96, 0.97];
const DEFAULT_EVENT_COLOR = '#3b82f6';

/** Characters the PDF's WinAnsi Helvetica cannot show become '?', in the preview as well. */
function toPrintable(str) {
  if (!str) return '';
  return String(str).replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function sanitizePdfText(str) {
  return toPrintable(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Approximate Helvetica advance widths (em fractions); used to cut text to its box.
function charWidth(ch, bold) {
  let w;
  if (' .,;:!|il\'`ijtfI'.includes(ch)) w = 0.28;
  else if ('mwMW'.includes(ch)) w = 0.85;
  else if (ch >= 'A' && ch <= 'Z') w = 0.68;
  else w = 0.556;
  return bold ? w * 1.06 : w;
}

function textWidth(text, size, bold = false) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, bold);
  return w * size;
}

function fitText(text, size, maxWidth, bold = false) {
  const t = toPrintable(text);
  if (maxWidth <= 0) return '';
  if (textWidth(t, size, bold) <= maxWidth) return t;
  let cut = t;
  while (cut.length > 0 && textWidth(cut + '...', size, bold) > maxWidth) cut = cut.slice(0, -1);
  return cut.length > 0 ? cut.trimEnd() + '...' : '';
}

function wrapText(text, size, maxWidth, maxLines) {
  const lines = [];
  for (const para of toPrintable(String(text || '').replace(/\r/g, '')).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size) <= maxWidth || !line) {
        line = next;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitText(kept[maxLines - 1] + ' ...', size, maxWidth);
    return kept.map(l => fitText(l, size, maxWidth));
  }
  return lines.map(l => fitText(l, size, maxWidth));
}

// ── colours ─────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const v = parseInt((m ? m[1] : DEFAULT_EVENT_COLOR.slice(1)), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function mix(rgb, toward, amount) {
  return rgb.map((c, i) => c + (toward[i] - c) * amount);
}

// ── dates (wall-clock strings, no time zone) ───────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function ymdOf(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function weekdayIdx(n) {
  return (new Date(n * 86400000).getUTCDay() + 6) % 7; // 0 = Monday
}

function isoWeek(n) {
  const thursday = n - weekdayIdx(n) + 3;
  const year = new Date(thursday * 86400000).getUTCFullYear();
  return 1 + Math.floor((thursday - dayNum(`${year}-01-01`)) / 7);
}

function shortDate(o, n) {
  return fmt(o, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(utc(n));
}

function dayMonth(o, n) {
  return fmt(o, { day: '2-digit', month: '2-digit' }).format(utc(n));
}

function longDate(o, n) {
  return fmt(o, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(utc(n));
}

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 'YYYY-MM-DDTHH:mm…' read as the wall-clock time the browser showed. */
function parseWall(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!m) return null;
  return { day: dayNum(m[1]), min: m[2] ? Number(m[2]) * 60 + Number(m[3]) : 0 };
}

/** Events with their start/end as day numbers and minutes; the end is exclusive. */
function normalizeEvents(events, calendars) {
  const colorOf = new Map(calendars.map(c => [c.id, c.color]));
  const nameOf = new Map(calendars.map(c => [c.id, c.name]));
  const out = [];
  for (const ev of events) {
    if (!colorOf.has(ev.calendarId)) continue;
    const start = parseWall(ev.start || ev.dtstart);
    if (!start) continue;
    const allDay = Boolean(ev.allDay);
    let end = parseWall(ev.end || ev.dtend) || (allDay ? { day: start.day + 1, min: 0 } : { day: start.day, min: start.min + 60 });
    if (allDay) {
      if (end.day <= start.day) end = { day: start.day + 1, min: 0 };
    } else if (end.day * 1440 + end.min <= start.day * 1440 + start.min) {
      end = { day: start.day, min: start.min + 30 };
    }
    out.push({
      title: ev.title || ev.summary || '(ohne Titel)',
      description: ev.description || '',
      location: ev.location || '',
      allDay,
      start,
      end,
      color: colorOf.get(ev.calendarId),
      calendarName: nameOf.get(ev.calendarId) || ''
    });
  }
  return out.sort((a, b) => (a.start.day - b.start.day) || (Number(b.allDay) - Number(a.allDay)) ||
    (a.start.min - b.start.min) || a.title.localeCompare(b.title));
}

function eventsOnDay(events, n) {
  return events.filter(ev => {
    if (ev.allDay) return ev.start.day <= n && n < ev.end.day;
    const s = ev.start.day * 1440 + ev.start.min;
    const e = ev.end.day * 1440 + ev.end.min;
    return s < (n + 1) * 1440 && e > n * 1440;
  });
}

// ── options ─────────────────────────────────────────────────────────────────

/** Checks the request body; returns { options } or { error } with a German message. */
function parseExportOptions(body) {
  const b = body || {};
  if (!VIEWS.includes(b.view)) return { error: 'Ungültige Ansicht (month, week, day oder list)' };
  if (!DATE_RE.test(b.from || '') || !DATE_RE.test(b.to || '')) return { error: 'Zeitraum fehlt (from und to als JJJJ-MM-TT)' };
  const from = dayNum(b.from);
  const to = dayNum(b.to);
  if (to < from) return { error: 'Das Ende des Zeitraums liegt vor dem Anfang' };
  if (to - from + 1 > MAX_RANGE_DAYS) return { error: `Der Zeitraum darf höchstens ${MAX_RANGE_DAYS} Tage umfassen` };
  const paper = b.paper || 'a4';
  if (!PAPER[paper]) return { error: 'Ungültiges Papierformat (a4 oder letter)' };
  const orientation = b.orientation || 'landscape';
  if (orientation !== 'portrait' && orientation !== 'landscape') return { error: 'Ungültige Ausrichtung (portrait oder landscape)' };
  if (!Array.isArray(b.calendars) || b.calendars.some(c => !c || typeof c.id !== 'string')) {
    return { error: 'Kalenderauswahl fehlt' };
  }
  if (b.events !== undefined && !Array.isArray(b.events)) return { error: 'events muss eine Liste sein' };
  const language = b.language === undefined ? 'de' : b.language;
  if (!Object.hasOwn(LANGUAGES, language)) return { error: 'Ungültige Sprache (de, de-formal oder en)' };
  return {
    options: {
      view: b.view,
      from,
      to,
      paper,
      orientation,
      descriptions: b.descriptions === true,
      color: b.color !== false,
      title: typeof b.title === 'string' ? b.title.slice(0, 120) : '',
      calendars: b.calendars.map(c => ({ id: c.id, name: String(c.name || ''), color: String(c.color || DEFAULT_EVENT_COLOR) })),
      events: b.events || [],
      language
    }
  };
}

// ── layout ──────────────────────────────────────────────────────────────────

class Page {
  constructor(width, height, color) {
    this.width = width;
    this.height = height;
    this.color = color;
    this.ops = [];
  }

  paint(rgb) {
    if (this.color) return rgb;
    const g = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return [g, g, g];
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    this.ops.push({ op: 'rect', x, y, w, h, fill: fill && this.paint(fill), stroke: stroke && this.paint(stroke), lineWidth });
  }

  line(x1, y1, x2, y2, stroke = RULE, lineWidth = 0.5) {
    this.ops.push({ op: 'line', x1, y1, x2, y2, stroke: this.paint(stroke), lineWidth });
  }

  text(text, x, y, { size = 9, fill = INK, bold = false } = {}) {
    if (!text) return;
    this.ops.push({ op: 'text', text: toPrintable(text), x, y, size, fill: this.paint(fill), bold });
  }

  /** An event drawn like the app: tinted fill with a coloured left edge. */
  eventBox(x, y, w, h, hex) {
    const base = hexToRgb(hex);
    this.rect(x, y, w, h, { fill: this.color ? mix(base, [1, 1, 1], 0.8) : [0.93, 0.93, 0.93] });
    this.rect(x, y, 2.5, h, { fill: this.color ? base : [0.25, 0.25, 0.25] });
  }
}

function newPage(o, heading) {
  const size = PAPER[o.paper];
  const landscape = o.orientation === 'landscape';
  const page = new Page(landscape ? size.height : size.width, landscape ? size.width : size.height, o.color);
  page.rect(MARGIN, MARGIN, page.width - 2 * MARGIN, HEADER_HEIGHT - 10, { fill: HEADER_FILL });
  page.text(fitText(heading, 15, page.width - 2 * MARGIN - 200, true), MARGIN + 10, MARGIN + 23, { size: 15, bold: true });
  if (o.title) {
    const t = fitText(o.title, 8, 180);
    page.text(t, page.width - MARGIN - 10 - textWidth(t, 8), MARGIN + 21, { size: 8, fill: MUTED });
  }
  return page;
}

function contentBox(page) {
  return {
    x: MARGIN,
    y: MARGIN + HEADER_HEIGHT,
    w: page.width - 2 * MARGIN,
    h: page.height - 2 * MARGIN - HEADER_HEIGHT - FOOTER_HEIGHT
  };
}

function layoutMonths(o, events) {
  const pages = [];
  const first = ymdOf(o.from).slice(0, 7);
  const last = ymdOf(o.to).slice(0, 7);
  let [y, m] = first.split('-').map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > last) break;
    const monthStart = dayNum(`${key}-01`);
    const monthEnd = dayNum(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`) - 1;
    const page = newPage(o, monthYear(o, monthStart));
    const box = contentBox(page);
    const colW = box.w / 7;
    const gridStart = monthStart - weekdayIdx(monthStart);
    const rows = Math.ceil((monthEnd - gridStart + 1) / 7);
    const headH = 16;
    const rowH = (box.h - headH) / rows;
    page.rect(box.x, box.y, box.w, headH, { fill: HEADER_FILL, stroke: RULE });
    [0, 1, 2, 3, 4, 5, 6].map(i => weekdayShort(o, i)).forEach((d, i) => page.text(d, box.x + i * colW + 6, box.y + 11, { size: 8, fill: MUTED, bold: true }));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 7; c++) {
        const n = gridStart + r * 7 + c;
        const cx = box.x + c * colW;
        const cy = box.y + headH + r * rowH;
        page.rect(cx, cy, colW, rowH, { stroke: RULE });
        if (n < monthStart || n > monthEnd) continue;
        page.text(String(n - monthStart + 1), cx + 5, cy + 11, { size: 9, bold: true });
        const dayEvents = eventsOnDay(events, n);
        const slots = Math.max(0, Math.floor((rowH - 18) / 12));
        const shown = dayEvents.length > slots ? Math.max(0, slots - 1) : dayEvents.length;
        dayEvents.slice(0, shown).forEach((ev, i) => {
          const ey = cy + 15 + i * 12;
          page.eventBox(cx + 2, ey, colW - 4, 11, ev.color);
          let tx = cx + 7;
          if (!ev.allDay && ev.start.day === n) {
            const t = hhmm(ev.start.min);
            page.text(t, tx, ey + 8, { size: 7, bold: true });
            tx += textWidth(t, 7, true) + 3;
          }
          page.text(fitText(ev.title, 7, cx + colW - 4 - tx), tx, ey + 8, { size: 7 });
        });
        if (shown < dayEvents.length) {
          page.text(`+${dayEvents.length - shown} weitere`, cx + 7, cy + 15 + shown * 12 + 8, { size: 7, fill: MUTED });
        }
      }
    }
    pages.push(page);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return pages;
}

/** Hour grid for one or several consecutive days. */
function layoutTimeGrid(page, o, days, events) {
  const box = contentBox(page);
  const gutter = 34;
  const colW = (box.w - gutter) / days.length;
  const headH = 16;
  const allDayRows = Math.max(...days.map(n => eventsOnDay(events, n).filter(e => e.allDay).length), 0);
  const allDayH = allDayRows > 0 ? allDayRows * 12 + 4 : 0;
  const timed = days.flatMap(n => eventsOnDay(events, n).filter(e => !e.allDay).map(e => ({ e, n })));
  let h0 = 8;
  let h1 = 18;
  for (const { e, n } of timed) {
    const s = e.start.day < n ? 0 : e.start.min;
    const end = e.end.day > n ? 1440 : e.end.min;
    h0 = Math.min(h0, Math.floor(s / 60));
    h1 = Math.max(h1, Math.ceil(end / 60));
  }
  const gridY = box.y + headH + allDayH;
  const hourH = (box.y + box.h - gridY) / (h1 - h0);

  page.rect(box.x, box.y, box.w, headH, { fill: HEADER_FILL, stroke: RULE });
  days.forEach((n, i) => {
    const label = days.length === 1 ? longDate(o, n) : `${weekdayShort(o, weekdayIdx(n))} ${dayMonth(o, n)}`;
    page.text(fitText(label, 8, colW - 8, true), box.x + gutter + i * colW + 5, box.y + 11, { size: 8, bold: true });
  });
  for (let h = h0; h <= h1; h++) {
    const y = gridY + (h - h0) * hourH;
    page.line(box.x + gutter, y, box.x + box.w, y);
    if (h < h1) page.text(`${String(h).padStart(2, '0')}:00`, box.x, y + 8, { size: 7, fill: MUTED });
  }
  for (let i = 0; i <= days.length; i++) {
    const x = box.x + gutter + i * colW;
    page.line(x, box.y, x, box.y + box.h);
  }

  days.forEach((n, i) => {
    const colX = box.x + gutter + i * colW;
    eventsOnDay(events, n).filter(e => e.allDay).forEach((ev, k) => {
      const y = box.y + headH + 2 + k * 12;
      page.eventBox(colX + 2, y, colW - 4, 11, ev.color);
      page.text(fitText(ev.title, 7, colW - 13), colX + 7, y + 8, { size: 7 });
    });

    // Overlapping events share the column side by side.
    const items = eventsOnDay(events, n).filter(e => !e.allDay).map(ev => ({
      ev, s: ev.start.day < n ? 0 : ev.start.min, e: ev.end.day > n ? 1440 : ev.end.min
    }));
    const laneEnds = [];
    for (const it of items) {
      let lane = laneEnds.findIndex(end => end <= it.s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = it.e;
      it.lane = lane;
    }
    const lanes = Math.max(1, laneEnds.length);
    const laneW = (colW - 4) / lanes;
    for (const it of items) {
      const x = colX + 2 + it.lane * laneW;
      const y = gridY + (it.s / 60 - h0) * hourH;
      const h = Math.max(11, ((it.e - it.s) / 60) * hourH - 1);
      page.eventBox(x, y, laneW - 1, h, it.ev.color);
      const innerW = laneW - 10;
      page.text(fitText(it.ev.title, 7.5, innerW, true), x + 6, y + 8.5, { size: 7.5, bold: true });
      let lineY = y + 8.5;
      const more = [];
      if (h >= 20) more.push(`${hhmm(it.s)}-${hhmm(it.e === 1440 ? 0 : it.e)}${it.ev.location ? ' ' + it.ev.location : ''}`);
      for (const t of more) {
        lineY += 9;
        page.text(fitText(t, 7, innerW), x + 6, lineY, { size: 7, fill: MUTED });
      }
      if (o.descriptions && it.ev.description) {
        const room = Math.floor((y + h - lineY - 3) / 8.5);
        for (const l of wrapText(it.ev.description, 6.5, innerW, Math.max(0, room))) {
          lineY += 8.5;
          page.text(l, x + 6, lineY, { size: 6.5 });
        }
      }
    }
  });
}

function layoutWeeks(o, events) {
  const pages = [];
  for (let monday = o.from - weekdayIdx(o.from); monday <= o.to; monday += 7) {
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => monday + i);
    const page = newPage(o, `${text(o).week(isoWeek(monday))} · ${shortDate(o, monday)} - ${shortDate(o, monday + 6)}`);
    layoutTimeGrid(page, o, days, events);
    pages.push(page);
  }
  return pages;
}

function layoutDays(o, events) {
  const pages = [];
  for (let n = o.from; n <= o.to; n++) {
    const page = newPage(o, longDate(o, n));
    layoutTimeGrid(page, o, [n], events);
    pages.push(page);
  }
  return pages;
}

function layoutList(o, events) {
  const heading = text(o).listHeading(`${shortDate(o, o.from)} - ${shortDate(o, o.to)}`);
  const pages = [];
  let page = null;
  let box = null;
  let y = 0;
  const start = () => {
    page = newPage(o, heading);
    box = contentBox(page);
    y = box.y;
    pages.push(page);
  };
  const ensure = (h) => { if (y + h > box.y + box.h) start(); };
  start();
  let any = false;
  for (let n = o.from; n <= o.to; n++) {
    const dayEvents = eventsOnDay(events, n);
    if (dayEvents.length === 0) continue;
    any = true;
    ensure(34);
    page.text(longDate(o, n), box.x, y + 12, { size: 10, bold: true });
    page.line(box.x, y + 16, box.x + box.w, y + 16, RULE, 0.75);
    y += 22;
    for (const ev of dayEvents) {
      const descLines = o.descriptions && ev.description ? wrapText(ev.description, 8, box.w - 110, 12) : [];
      const h = 14 + (ev.location ? 10 : 0) + descLines.length * 10;
      ensure(h + 4);
      page.rect(box.x + 86, y, 3, h - 2, { fill: o.color ? hexToRgb(ev.color) : [0.25, 0.25, 0.25] });
      let when;
      if (ev.allDay) when = text(o).allDay;
      else {
        const s = ev.start.day < n ? 0 : ev.start.min;
        const e = ev.end.day > n ? 1440 : ev.end.min;
        when = `${hhmm(s)} - ${hhmm(e === 1440 ? 0 : e)}`;
      }
      page.text(when, box.x, y + 9, { size: 8.5, fill: MUTED });
      const cal = ev.calendarName ? fitText(ev.calendarName, 7.5, 120) : '';
      const calW = cal ? textWidth(cal, 7.5) : 0;
      page.text(fitText(ev.title, 9, box.w - 100 - calW - 10, true), box.x + 96, y + 9, { size: 9, bold: true });
      if (cal) page.text(cal, box.x + box.w - calW, y + 9, { size: 7.5, fill: MUTED });
      let ly = y + 9;
      if (ev.location) {
        ly += 10;
        page.text(fitText(ev.location, 8, box.w - 100), box.x + 96, ly, { size: 8, fill: MUTED });
      }
      for (const l of descLines) {
        ly += 10;
        page.text(l, box.x + 96, ly, { size: 8 });
      }
      y += h + 4;
    }
  }
  if (!any) page.text(text(o).noEvents, box.x, y + 12, { size: 10, fill: MUTED });
  return pages;
}

function layoutDocument(options) {
  const events = normalizeEvents(options.events, options.calendars);
  const layout = { month: layoutMonths, week: layoutWeeks, day: layoutDays, list: layoutList }[options.view];
  const pages = layout(options, events);
  pages.forEach((p, i) => {
    const t = text(options).page(i + 1, pages.length);
    p.text(t, p.width - MARGIN - textWidth(t, 7), p.height - MARGIN, { size: 7, fill: MUTED });
  });
  return pages;
}

// ── back ends ───────────────────────────────────────────────────────────────

const f = (n) => Number(n.toFixed(2));
const rgbPdf = (c) => c.map(v => v.toFixed(3)).join(' ');

function pageToPdfStream(page) {
  const H = page.height;
  const out = [];
  for (const o of page.ops) {
    if (o.op === 'rect') {
      if (o.fill) out.push(`${rgbPdf(o.fill)} rg`);
      if (o.stroke) out.push(`${rgbPdf(o.stroke)} RG ${o.lineWidth} w`);
      const mode = o.fill && o.stroke ? 'B' : (o.fill ? 'f' : 'S');
      out.push(`${f(o.x)} ${f(H - o.y - o.h)} ${f(o.w)} ${f(o.h)} re ${mode}`);
    } else if (o.op === 'line') {
      out.push(`${rgbPdf(o.stroke)} RG ${o.lineWidth} w ${f(o.x1)} ${f(H - o.y1)} m ${f(o.x2)} ${f(H - o.y2)} l S`);
    } else {
      out.push(`BT ${rgbPdf(o.fill)} rg /${o.bold ? 'F2' : 'F1'} ${o.size} Tf ${f(o.x)} ${f(H - o.y)} Td (${sanitizePdfText(o.text)}) Tj ET`);
    }
  }
  return out.join('\n');
}

function toPdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((p, i) => {
    const stream = pageToPdfStream(p);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Contents ${pageIds[i] + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const startXref = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const rgbSvg = (c) => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;

function toSvg(page) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">`,
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#ffffff"/>`];
  for (const o of page.ops) {
    if (o.op === 'rect') {
      parts.push(`<rect x="${f(o.x)}" y="${f(o.y)}" width="${f(o.w)}" height="${f(o.h)}" fill="${o.fill ? rgbSvg(o.fill) : 'none'}"${o.stroke ? ` stroke="${rgbSvg(o.stroke)}" stroke-width="${o.lineWidth}"` : ''}/>`);
    } else if (o.op === 'line') {
      parts.push(`<line x1="${f(o.x1)}" y1="${f(o.y1)}" x2="${f(o.x2)}" y2="${f(o.y2)}" stroke="${rgbSvg(o.stroke)}" stroke-width="${o.lineWidth}"/>`);
    } else {
      parts.push(`<text x="${f(o.x)}" y="${f(o.y)}" font-family="Helvetica, Arial, sans-serif" font-size="${o.size}"${o.bold ? ' font-weight="bold"' : ''} fill="${rgbSvg(o.fill)}" xml:space="preserve">${escXml(o.text)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** The PDF for parsed export options (see parseExportOptions). */
function generateCalendarPDF(options) {
  return toPdf(layoutDocument(options));
}

/** The first page of the same document as SVG, with the page count and size. */
function renderPreview(options) {
  const pages = layoutDocument(options);
  return { svg: toSvg(pages[0]), pageCount: pages.length, width: pages[0].width, height: pages[0].height };
}

module.exports = {
  parseExportOptions,
  layoutDocument,
  generateCalendarPDF,
  renderPreview,
  sanitizePdfText
};
