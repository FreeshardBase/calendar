/**
 * eventModal.js — Event create/edit modal controller.
 */

import { store, calendarById } from './store.js';
import { EventsAPI } from './api.js';
import { showToast } from './app.js';

let _onSaved  = null;
let _onDeleted = null;
let _currentEvent = null; // null = create mode, object = edit mode

// ── DOM refs (lazily grabbed) ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function backdrop()  { return $('event-modal-backdrop'); }
function form()      { return $('event-form'); }

const COMMON_TIMEZONES = [
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Europe/Zurich',
  'Europe/Vienna',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'UTC'
];

function populateTimezoneSelects(selectedStartTz, selectedEndTz) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  const startTz = selectedStartTz || localTz;
  const endTz   = selectedEndTz   || localTz;

  const tzs = [...COMMON_TIMEZONES];
  if (!tzs.includes(localTz)) tzs.push(localTz);
  if (selectedStartTz && !tzs.includes(selectedStartTz)) tzs.push(selectedStartTz);
  if (selectedEndTz && !tzs.includes(selectedEndTz)) tzs.push(selectedEndTz);

  tzs.sort();

  const startSel = $('ev-start-tz');
  const endSel   = $('ev-end-tz');

  startSel.innerHTML = tzs.map(tz => `<option value="${tz}">${tz}</option>`).join('');
  endSel.innerHTML   = tzs.map(tz => `<option value="${tz}">${tz}</option>`).join('');

  startSel.value = startTz;
  endSel.value   = endTz;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openCreateModal(defaultDate, callbacks) {
  _currentEvent = null;
  _onSaved   = callbacks?.onSaved;
  _onDeleted = callbacks?.onDeleted;

  resetForm();
  $('event-modal-title').textContent = 'Neuer Termin';
  $('delete-event-btn').style.display = 'none';

  // Pre-fill date from defaultDate
  if (defaultDate) {
    const d = new Date(defaultDate);
    $('ev-start-date').value = toInputDate(d);
    $('ev-end-date').value   = toInputDate(d);

    // If hour is set (not midnight), pre-fill time
    if (d.getHours() !== 0) {
      $('ev-start-time').value = toInputTime(d);
      const end = new Date(d); end.setHours(end.getHours() + 1);
      $('ev-end-time').value   = toInputTime(end);
    } else {
      // Default to next full hour from now
      const now = new Date();
      now.setMinutes(0, 0, 0);
      now.setHours(now.getHours() + 1);
      $('ev-start-time').value = toInputTime(now);
      const end = new Date(now); end.setHours(end.getHours() + 1);
      $('ev-end-time').value   = toInputTime(end);
    }
  }

  populateCalendarSelect();
  populateTimezoneSelects();
  show();
}

export function openEditModal(event, callbacks) {
  _currentEvent = event;
  _onSaved   = callbacks?.onSaved;
  _onDeleted = callbacks?.onDeleted;

  $('event-modal-title').textContent = 'Termin bearbeiten';
  $('delete-event-btn').style.display = 'block';

  resetForm();
  populateCalendarSelect(event.calendarId);

  // Fill form
  $('ev-uid').value   = event.uid   || '';
  $('ev-href').value  = event.href  || '';
  $('ev-etag').value  = event.etag  || '';

  $('ev-title').value       = event.title       || '';
  $('ev-location').value    = event.location    || '';
  $('ev-description').value = event.description || '';

  const allDay = event.allDay;
  $('ev-allday').checked = allDay;
  updateAlldayUI(allDay);

  if (event.start) {
    const s = new Date(event.start);
    $('ev-start-date').value = toInputDate(s, event.startTimeZone);
    if (!allDay) $('ev-start-time').value = toInputTime(s, event.startTimeZone);
  }
  if (event.end) {
    const e = new Date(event.end);
    $('ev-end-date').value = toInputDate(e, event.endTimeZone);
    if (!allDay) $('ev-end-time').value = toInputTime(e, event.endTimeZone);
  }

  // Attendees
  renderAttendeeList(event.attendees || []);

  // Recurrence
  let freq = '';
  const rruleStr = event.recurrence || '';
  if (rruleStr.includes('FREQ=DAILY')) freq = 'DAILY';
  else if (rruleStr.includes('FREQ=WEEKLY')) freq = 'WEEKLY';
  else if (rruleStr.includes('FREQ=MONTHLY')) freq = 'MONTHLY';
  else if (rruleStr.includes('FREQ=YEARLY')) freq = 'YEARLY';
  $('ev-recurrence').value = freq;

  populateTimezoneSelects(event.startTimeZone, event.endTimeZone);

  show();
}

export function closeModal() {
  backdrop().classList.add('hidden');
  _currentEvent = null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function show() {
  backdrop().classList.remove('hidden');
  setTimeout(() => $('ev-title').focus(), 50);
}

function resetForm() {
  form().reset();
  $('ev-uid').value  = '';
  $('ev-href').value = '';
  $('ev-etag').value = '';
  $('ev-recurrence').value = '';
  $('event-form-error').classList.add('hidden');
  $('ev-attendee-list').innerHTML = '';

  const now = new Date();
  $('ev-start-date').value = toInputDate(now);
  $('ev-end-date').value   = toInputDate(now);
  updateAlldayUI(false);
  setButtonLoading('event-save-btn', false);
}

function updateAlldayUI(allDay) {
  $('ev-start-time-group').style.display = allDay ? 'none' : '';
  $('ev-end-time-group').style.display   = allDay ? 'none' : '';
  $('ev-start-tz-group').style.display   = allDay ? 'none' : '';
  $('ev-end-tz-group').style.display     = allDay ? 'none' : '';
}

function populateCalendarSelect(selectedId) {
  const sel = $('ev-calendar');
  const cals = store.get('calendars') || [];
  const targetId = selectedId || (cals[0] ? cals[0].id : '');
  sel.innerHTML = cals.map(c =>
    `<option value="${c.id}" ${c.id === targetId ? 'selected' : ''}>${c.name}</option>`
  ).join('') || '<option value="">— Kein Kalender verfügbar —</option>';
}

function renderAttendeeList(attendees) {
  const list = $('ev-attendee-list');
  list.innerHTML = attendees.map((a, i) => `
    <li class="attendee-item">
      <span class="attendee-name">${escHtml(a.name || '')}</span>
      <span class="attendee-email">${escHtml(a.email)}</span>
      <span class="attendee-status ${a.status}">${statusLabel(a.status)}</span>
      <button type="button" class="attendee-remove" data-idx="${i}" aria-label="Entfernen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </li>`
  ).join('');
}

function collectAttendees() {
  return [...$('ev-attendee-list').querySelectorAll('.attendee-item')].map(li => ({
    name:   li.querySelector('.attendee-name').textContent.trim(),
    email:  li.querySelector('.attendee-email').textContent.trim(),
    status: li.querySelector('.attendee-status').className.split(' ').pop()
  }));
}

async function handleSubmit(e) {
  e.preventDefault();

  const allDay = $('ev-allday').checked;
  const startDateVal = $('ev-start-date').value;
  const endDateVal   = $('ev-end-date').value;

  if (!$('ev-title').value.trim()) {
    showError('Bitte gib einen Titel ein.');
    return;
  }
  if (!$('ev-calendar').value) {
    showError('Bitte wähle einen Kalender aus.');
    return;
  }
  if (!startDateVal || !endDateVal) {
    showError('Bitte fülle Datum und Uhrzeit aus.');
    return;
  }

function getUtcDate(dateStr, timeStr, timeZone) {
  const iso = `${dateStr}T${timeStr || '00:00'}:00.000Z`;
  const temp = new Date(iso);
  if (isNaN(temp.getTime())) return temp;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(temp);
  const partMap = {};
  for (const p of parts) partMap[p.type] = p.value;
  
  let hour = partMap.hour;
  if (hour === '24') hour = '00';
  
  const localIso = `${partMap.year}-${partMap.month}-${partMap.day}T${hour}:${partMap.minute}:${partMap.second}.000Z`;
  const localTemp = new Date(localIso);
  
  const diff = temp.getTime() - localTemp.getTime();
  return new Date(temp.getTime() + diff);
}

  let startUtc, endUtc;
  const startTimeZone = $('ev-start-tz').value;
  const endTimeZone   = $('ev-end-tz').value;

  if (allDay) {
    startUtc = startDateVal;
    endUtc   = endDateVal;
  } else {
    const startTimeVal = $('ev-start-time').value || '00:00';
    const endTimeVal   = $('ev-end-time').value   || '01:00';
    startUtc = getUtcDate(startDateVal, startTimeVal, startTimeZone).toISOString();
    endUtc   = getUtcDate(endDateVal, endTimeVal, endTimeZone).toISOString();
  }

  const recurrenceVal = $('ev-recurrence').value;
  const payload = {
    calendarId:  $('ev-calendar').value,
    title:       $('ev-title').value.trim(),
    start:       startUtc,
    end:         endUtc,
    allDay,
    location:    $('ev-location').value.trim()    || null,
    description: $('ev-description').value.trim() || null,
    attendees:   collectAttendees(),
    recurrence:  recurrenceVal ? `FREQ=${recurrenceVal}` : null,
    startTimeZone: allDay ? null : startTimeZone,
    endTimeZone:   allDay ? null : endTimeZone
  };

  setButtonLoading('event-save-btn', true);
  $('event-form-error').classList.add('hidden');

  try {
    if (_currentEvent) {
      // Update
      const targetUid = _currentEvent.masterUid || _currentEvent.uid;
      payload.uid  = targetUid;
      payload.href = _currentEvent.href;
      payload.etag = _currentEvent.etag;
      const saved = await EventsAPI.update(targetUid, payload);
      closeModal();
      showToast('Termin gespeichert.', 'success');
      _onSaved?.(saved);
    } else {
      // Create
      const created = await EventsAPI.create(payload);
      closeModal();
      showToast('Termin erstellt.', 'success');
      _onSaved?.(created);
    }
  } catch (err) {
    if (err.status === 409) {
      showError('Konflikt: Der Termin wurde von einem anderen Client geändert. Seite neu laden.');
    } else {
      showError(err.message);
    }
    setButtonLoading('event-save-btn', false);
  }
}

async function handleDelete() {
  if (!_currentEvent) return;
  if (!confirm(`„${_currentEvent.title}" wirklich löschen?`)) return;

  setButtonLoading('event-save-btn', true);
  try {
    const targetUid = _currentEvent.masterUid || _currentEvent.uid;
    await EventsAPI.remove(targetUid, {
      calendarId: _currentEvent.calendarId,
      etag:       _currentEvent.etag,
      href:       _currentEvent.href
    });
    closeModal();
    showToast('Termin gelöscht.', 'info');
    _onDeleted?.(targetUid);
  } catch (err) {
    showError(err.message);
    setButtonLoading('event-save-btn', false);
  }
}

function showError(msg) {
  const el = $('event-form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Attendee add logic ────────────────────────────────────────────────────────

function handleAddAttendee() {
  const name  = $('ev-attendee-name').value.trim();
  const email = $('ev-attendee-email').value.trim();
  if (!email) return;

  const list = $('ev-attendee-list');
  const idx  = list.querySelectorAll('.attendee-item').length;

  const li = document.createElement('li');
  li.className = 'attendee-item';
  li.innerHTML = `
    <span class="attendee-name">${escHtml(name)}</span>
    <span class="attendee-email">${escHtml(email)}</span>
    <span class="attendee-status NEEDS-ACTION">Ausstehend</span>
    <button type="button" class="attendee-remove" data-idx="${idx}" aria-label="Entfernen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>`;

  list.appendChild(li);
  $('ev-attendee-name').value  = '';
  $('ev-attendee-email').value = '';
  $('ev-attendee-name').focus();
}

// ── Init (called once from app.js) ───────────────────────────────────────────

export function initEventModal() {
  $('event-modal-close').addEventListener('click', closeModal);
  $('event-cancel-btn').addEventListener('click',  closeModal);
  $('event-save-btn').addEventListener('click', e => { /* handled by form submit */ });
  form().addEventListener('submit', handleSubmit);
  $('delete-event-btn').addEventListener('click', handleDelete);

  $('ev-allday').addEventListener('change', e => updateAlldayUI(e.target.checked));
  $('add-attendee-btn').addEventListener('click', handleAddAttendee);

  // Remove attendee on click
  $('ev-attendee-list').addEventListener('click', e => {
    const btn = e.target.closest('.attendee-remove');
    if (btn) btn.closest('.attendee-item').remove();
  });

  // Password toggle
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Close on backdrop click
  backdrop().addEventListener('click', e => {
    if (e.target === backdrop()) closeModal();
  });

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !backdrop().classList.contains('hidden')) closeModal();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toInputDate(d, tzid) {
  if (tzid) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const partMap = {};
    for (const p of parts) partMap[p.type] = p.value;
    return `${partMap.year}-${partMap.month}-${partMap.day}`;
  }
  return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD
}
function toInputTime(d, tzid) {
  if (tzid) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    const partMap = {};
    for (const p of parts) partMap[p.type] = p.value;
    let hour = partMap.hour;
    if (hour === '24') hour = '00';
    return `${hour}:${partMap.minute}`;
  }
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function setButtonLoading(id, on) {
  const btn = $(id);
  btn.querySelector('.btn-label').style.display = on ? 'none' : '';
  btn.querySelector('.btn-spinner').classList.toggle('hidden', !on);
  btn.disabled = on;
}
function statusLabel(s) {
  return { ACCEPTED: 'Zugesagt', DECLINED: 'Abgelehnt', TENTATIVE: 'Vorläufig', 'NEEDS-ACTION': 'Ausstehend' }[s] || s;
}
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
