/**
 * PDF export dialog (#511): range, view, calendars, paper, orientation, descriptions and colour,
 * with a preview of the first page. The preview is drawn by the server from the same page layout
 * as the PDF (server/utils/pdfExport.js), so the dialog shows what the file will print.
 */
import { store } from './store.js';
import { EventsAPI } from './api.js';
import { openDialog, closeDialog } from './dialogFocus.js';
import { calendarLabel, holdsEvents } from './calendarLabels.js';
import { sanitizeColor } from './calendar.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const wall = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

let showToast = () => {};
let previewSeq = 0;
let previewUrl = null;
let previewTimer = null;
let loaded = { key: null, events: null };

/** The range the calendar shows now, as the dialog's starting point. */
function defaultRange(view, date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  if (view === 'day') return [d, d];
  if (view === 'week') {
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return [monday, sunday];
  }
  if (view === 'list') {
    const end = new Date(d); end.setDate(d.getDate() + 29);
    return [d, end];
  }
  return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)];
}

function exportView(view) {
  if (view === 'week' || view === 'workweek' || view === '3day') return 'week';
  if (view === 'day' || view === 'list') return view;
  return 'month';
}

function renderCalendarChoices() {
  const hidden = store.get('hiddenCalendars');
  const box = $('pdf-calendars');
  box.textContent = '';
  for (const cal of (store.get('calendars') || []).filter(holdsEvents)) {
    const label = document.createElement('label');
    label.className = 'pdf-export-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = cal.id;
    input.checked = !hidden.has(cal.id);
    const dot = document.createElement('span');
    dot.className = 'calendar-dot';
    dot.style.background = sanitizeColor(cal.color);
    label.append(input, dot, document.createTextNode(` ${calendarLabel(cal)}`));
    box.appendChild(label);
  }
}

function readSettings() {
  const chosen = new Set([...$('pdf-calendars').querySelectorAll('input:checked')].map(i => i.value));
  const calendars = (store.get('calendars') || []).filter(c => chosen.has(c.id))
    .map(c => ({ id: c.id, name: calendarLabel(c), color: sanitizeColor(c.color) }));
  return {
    view: $('pdf-view').value,
    from: $('pdf-from').value,
    to: $('pdf-to').value,
    paper: $('pdf-paper').value,
    orientation: $('pdf-orientation').value,
    descriptions: $('pdf-descriptions').checked,
    color: $('pdf-color').value === 'color',
    title: $('toolbar-title').textContent || '',
    calendars
  };
}

/** The range's events in the browser's wall-clock time, loaded once per range. */
async function rangeEvents(from, to) {
  const key = `${from}_${to}`;
  if (loaded.key === key) return loaded.events;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T23:59:59.999`);
  if (isNaN(start) || isNaN(end)) throw new Error('Ungültiger Zeitraum');
  const { events, errors } = await EventsAPI.list(start.toISOString(), end.toISOString());
  if (errors.length > 0) throw new Error('Nicht alle Kalender konnten gelesen werden');
  const mapped = events.map(ev => ({
    calendarId: ev.calendarId,
    title: ev.title,
    description: ev.description || '',
    location: ev.location || '',
    allDay: Boolean(ev.allDay),
    start: ev.allDay ? String(ev.start).slice(0, 10) : wall(new Date(ev.start)),
    end: ev.end ? (ev.allDay ? String(ev.end).slice(0, 10) : wall(new Date(ev.end))) : null
  }));
  loaded = { key, events: mapped };
  return mapped;
}

async function payload() {
  const settings = readSettings();
  const chosen = new Set(settings.calendars.map(c => c.id));
  const events = (await rangeEvents(settings.from, settings.to)).filter(ev => chosen.has(ev.calendarId));
  return { ...settings, events };
}

async function postExport(kind, body) {
  const res = await fetch(`/api/calendars/export/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok) {
    const err = type.includes('application/json') ? await res.json() : null;
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return { res, type, blob: await res.blob() };
}

function setStatus(text, isError = false) {
  const status = $('pdf-preview-status');
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.setAttribute('role', isError ? 'alert' : 'status');
}

async function updatePreview() {
  const seq = ++previewSeq;
  setStatus('Vorschau wird erstellt…');
  $('pdf-export-modal').setAttribute('aria-busy', 'true');
  try {
    const { res, type, blob } = await postExport('preview', await payload());
    if (seq !== previewSeq) return;
    if (!type.startsWith('image/svg+xml')) throw new Error('Die Antwort ist keine Vorschau');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const img = $('pdf-preview-img');
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Die Vorschau konnte nicht angezeigt werden'));
      img.src = previewUrl;
    });
    if (seq !== previewSeq) return;
    const pages = Number(res.headers.get('X-Export-Pages'));
    setStatus(`Seite 1 von ${pages}`);
  } catch (err) {
    if (seq !== previewSeq) return;
    console.error('[PDF Preview Error]', err);
    setStatus(`Vorschau fehlgeschlagen: ${err.message}`, true);
  } finally {
    if (seq === previewSeq) $('pdf-export-modal').removeAttribute('aria-busy');
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 200);
}

async function download() {
  const btn = $('pdf-export-download');
  btn.disabled = true;
  let blob;
  let view;
  try {
    const body = await payload();
    view = body.view;
    // #497: the file is checked completely before the download starts; a failed export is shown
    // as an error, never handed to the browser as a broken download or replaced by a print dialog.
    const answer = await postExport('pdf', body);
    blob = answer.blob;
    if (!answer.type.startsWith('application/pdf') || await blob.slice(0, 5).text() !== '%PDF-') {
      throw new Error('Die Antwort ist keine PDF-Datei');
    }
  } catch (err) {
    console.error('[PDF Export Error]', err);
    showToast(`PDF-Export fehlgeschlagen: ${err.message}`, 'error');
    return;
  } finally {
    btn.disabled = false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `calendar-${view}-${Date.now()}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking right after click() lets Chromium's download manager find the blob gone and fail
  // the download it has just announced (#497); the URL lives until the download has read it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  closeExportDialog();
}

function closeExportDialog() {
  clearTimeout(previewTimer);
  previewSeq++;
  closeDialog($('pdf-export-backdrop'));
}

export function openExportDialog() {
  const view = exportView(store.get('view'));
  const [from, to] = defaultRange(view, store.get('currentDate') || new Date());
  $('pdf-view').value = view;
  $('pdf-from').value = ymd(from);
  $('pdf-to').value = ymd(to);
  loaded = { key: null, events: null };
  renderCalendarChoices();
  openDialog($('pdf-export-backdrop'), $('pdf-view'));
  updatePreview();
}

export function initPdfExport(options) {
  showToast = options.showToast;
  $('export-pdf-btn').addEventListener('click', openExportDialog);
  $('pdf-export-close').addEventListener('click', closeExportDialog);
  $('pdf-export-cancel').addEventListener('click', closeExportDialog);
  $('pdf-export-download').addEventListener('click', download);
  // A new view also moves the range to the one that view shows around the chosen start.
  $('pdf-view').addEventListener('change', () => {
    const start = $('pdf-from').value ? new Date(`${$('pdf-from').value}T00:00:00`) : new Date();
    const [from, to] = defaultRange($('pdf-view').value, start);
    $('pdf-from').value = ymd(from);
    $('pdf-to').value = ymd(to);
  });
  $('pdf-export-form').addEventListener('change', schedulePreview);
  $('pdf-export-form').addEventListener('submit', (e) => e.preventDefault());
}
