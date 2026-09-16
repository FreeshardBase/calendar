/**
 * eventModal.js — Event create/edit modal controller.
 */

import { store, calendarById } from './store.js';
import { EventsAPI } from './api.js';
import { showToast } from './app.js';
import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';

let _onSaved  = null;
let _onDeleted = null;
let _currentEvent = null; // null = create mode, object = edit mode
let _recurrenceTouched = false;

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

export function formatAlarmTriggerLabel(trigger) {
  if (!trigger) return 'Keine Erinnerung';
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return 'Zum Zeitpunkt des Termins';

  const presets = {
    'PT0S': 'Zum Zeitpunkt des Termins',
    '-PT5M': '5 Minuten vorher',
    '-PT15M': '15 Minuten vorher',
    '-PT30M': '30 Minuten vorher',
    '-PT1H': '1 Stunde vorher',
    '-P1D': '1 Tag vorher'
  };
  if (presets[str]) return presets[str];

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return `Erinnerung (${str})`;

  const isNegative = match[1] === '-';
  const weeks = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  const hours = parseInt(match[4] || '0', 10);
  const minutes = parseInt(match[5] || '0', 10);
  const seconds = parseInt(match[6] || '0', 10);

  const parts = [];
  if (weeks > 0) parts.push(`${weeks} Woche${weeks > 1 ? 'n' : ''}`);
  if (days > 0) parts.push(`${days} Tag${days > 1 ? 'e' : ''}`);
  if (hours > 0) parts.push(`${hours} Stunde${hours > 1 ? 'n' : ''}`);
  if (minutes > 0) parts.push(`${minutes} Minute${minutes > 1 ? 'n' : ''}`);
  if (seconds > 0) parts.push(`${seconds} Sekunde${seconds > 1 ? 'n' : ''}`);

  if (parts.length === 0) return 'Zum Zeitpunkt des Termins';

  const suffix = isNegative ? 'vorher' : 'nachher';
  return `${parts.join(' ')} ${suffix}`;
}


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
  $('event-save-btn').style.display = '';

  const activeCurrentDate = store.get('currentDate');
  const d = defaultDate ? new Date(defaultDate) : (activeCurrentDate ? new Date(activeCurrentDate) : new Date());
  $('ev-start-date').value = toInputDate(d, null, true);
  $('ev-end-date').value   = toInputDate(d, null, true);

  if (defaultDate && d.getHours() !== 0) {
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

  populateCalendarSelect();
  populateTimezoneSelects();

  // Pre-check the weekday of the start date
  document.querySelectorAll('.recur-byday').forEach(cb => cb.checked = false);
  const startDateVal = $('ev-start-date').value;
  if (startDateVal) {
    const parts = startDateVal.split('-').map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    const dayCode = ['SU','MO','TU','WE','TH','FR','SA'][d.getUTCDay()];
    const cb = document.querySelector(`.recur-byday[value="${dayCode}"]`);
    if (cb) cb.checked = true;
  }
  updateRecurrenceOptions();

  show();
}

export function openEditModal(event, callbacks) {
  _currentEvent = event;
  _onSaved   = callbacks?.onSaved;
  _onDeleted = callbacks?.onDeleted;

  $('event-modal-title').textContent = 'Termin bearbeiten';

  resetForm();
  populateCalendarSelect(event.calendarId);

  const cal = (store.get('calendars') || []).find(c => c.id === event.calendarId);
  const isReadOnly = cal ? !!cal.readOnly : false;

  $('event-save-btn').style.display = isReadOnly ? 'none' : '';
  $('delete-event-btn').style.display = isReadOnly ? 'none' : 'block';

  let warningEl = $('event-modal-warning');
  if (!warningEl) {
    warningEl = document.createElement('div');
    warningEl.id = 'event-modal-warning';
    warningEl.style.cssText = 'font-size:0.8rem;color:var(--danger);padding:8px 12px;background:#fee2e2;border-radius:4px;margin-bottom:12px;font-weight:600;line-height:1.4;';
    const fm = form();
    fm.parentNode.insertBefore(warningEl, fm);
  }

  if (isReadOnly) {
    warningEl.textContent = 'Dieser Termin ist schreibgeschützt (Kalender wurde schreibgeschützt geteilt).';
    warningEl.classList.remove('hidden');
    setFormDisabled(true);
  } else {
    warningEl.classList.add('hidden');
    setFormDisabled(false);
  }

  // Fill form
  $('ev-uid').value   = event.uid   || '';
  $('ev-href').value  = event.href  || '';
  $('ev-etag').value  = event.etag  || '';

  $('ev-title').value       = event.title       || '';
  $('ev-location').value    = event.location    || '';
  $('ev-description').value = event.description || '';
  if ($('ev-categories')) {
    const catList = Array.isArray(event.categories) ? event.categories : [];
    $('ev-categories').value = catList.join(', ');
  }

  const allDay = event.allDay;
  $('ev-allday').checked = allDay;
  updateAlldayUI(allDay);

  if (event.start) {
    if (allDay) {
      $('ev-start-date').value = toInputDate(event.start, null, true);
    } else {
      const s = new Date(event.start);
      $('ev-start-date').value = toInputDate(s, event.startTimeZone);
      $('ev-start-time').value = toInputTime(s, event.startTimeZone);
    }
  }
  if (event.end) {
    if (allDay) {
      const eDate = new Date(event.end);
      const sDate = event.start ? new Date(event.start) : eDate;
      if (eDate > sDate) {
        eDate.setUTCDate(eDate.getUTCDate() - 1);
      }
      $('ev-end-date').value = toInputDate(eDate, null, true);
    } else {
      const e = new Date(event.end);
      $('ev-end-date').value = toInputDate(e, event.endTimeZone);
      $('ev-end-time').value = toInputTime(e, event.endTimeZone);
    }
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

  // Reset checkboxes and radio buttons
  document.querySelectorAll('.recur-byday').forEach(cb => cb.checked = false);
  const byMonthDayRadio = document.querySelector('input[name="recur-monthly-type"][value="BYMONTHDAY"]');
  if (byMonthDayRadio) byMonthDayRadio.checked = true;

  if (freq === 'WEEKLY') {
    const bydayMatch = rruleStr.match(/BYDAY=([^;]+)/);
    if (bydayMatch) {
      const days = bydayMatch[1].split(',');
      days.forEach(day => {
        const cb = document.querySelector(`.recur-byday[value="${day}"]`);
        if (cb) cb.checked = true;
      });
    }
  } else if (freq === 'MONTHLY') {
    const bydayMatch = rruleStr.match(/BYDAY=(-?\d)([A-Z]{2})/);
    if (bydayMatch) {
      const weekIdx = bydayMatch[1];
      const weekday = bydayMatch[2];
      $('recur-monthly-week-idx').value = weekIdx;
      $('recur-monthly-weekday').value = weekday;
      const byDayRadio = document.querySelector('input[name="recur-monthly-type"][value="BYDAY"]');
      if (byDayRadio) byDayRadio.checked = true;
    } else {
      if (byMonthDayRadio) byMonthDayRadio.checked = true;
    }
  }

  // Parse Recurrence End
  const untilMatch = rruleStr.match(/UNTIL=([^;]+)/);
  const countMatch = rruleStr.match(/COUNT=(\d+)/);
  if (untilMatch) {
    const rawVal = untilMatch[1];
    const year = rawVal.slice(0, 4);
    const month = rawVal.slice(4, 6);
    const day = rawVal.slice(6, 8);
    $('recur-end-date').value = `${year}-${month}-${day}`;
    const untilRadio = document.querySelector('input[name="recur-end-type"][value="UNTIL"]');
    if (untilRadio) untilRadio.checked = true;
  } else if (countMatch) {
    $('recur-end-count').value = countMatch[1];
    const countRadio = document.querySelector('input[name="recur-end-type"][value="COUNT"]');
    if (countRadio) countRadio.checked = true;
  } else {
    const neverRadio = document.querySelector('input[name="recur-end-type"][value="NEVER"]');
    if (neverRadio) neverRadio.checked = true;
  }

  populateTimezoneSelects(event.startTimeZone, event.endTimeZone);
  updateRecurrenceOptions(true);

  // Alarms
  const firstAlarm = (event.alarms && event.alarms.length > 0) ? event.alarms[0] : null;
  const alarmSelect = $('ev-alarm');
  if (alarmSelect) {
    Array.from(alarmSelect.options).forEach(opt => {
      if (opt.dataset && opt.dataset.customAlarm === 'true') {
        opt.remove();
      }
    });
    const triggerVal = firstAlarm ? (firstAlarm.trigger || '') : '';
    if (triggerVal) {
      let optionExists = Array.from(alarmSelect.options).some(opt => opt.value === triggerVal);
      if (!optionExists) {
        const opt = document.createElement('option');
        opt.value = triggerVal;
        opt.textContent = formatAlarmTriggerLabel(triggerVal);
        opt.dataset.customAlarm = 'true';
        alarmSelect.appendChild(opt);
      }
    }
    alarmSelect.value = triggerVal;
  }


  // Attachments
  const firstAttach = (event.attachments && event.attachments.length > 0) ? event.attachments[0] : null;
  if ($('ev-attachment-url')) $('ev-attachment-url').value = firstAttach ? (firstAttach.url || '') : '';
  if ($('ev-attachment-name')) $('ev-attachment-name').value = firstAttach ? (firstAttach.name || '') : '';

  _recurrenceTouched = false;
  show();
}

export function closeModal() {
  closeDialog(backdrop());
  _currentEvent = null;
}

/**
 * Ask whether an action on a recurring event applies to a single occurrence
 * or the whole series. Resolves 'occurrence' | 'series' | null (cancelled).
 */
export function chooseRecurrenceScope(question) {
  return new Promise(resolve => {
    const popover = document.getElementById('event-popover');
    if (popover) popover.classList.add('hidden');

    const bd = $('scope-dialog-backdrop');
    $('scope-dialog-text').textContent = question;

    const done = value => {
      closeDialog(bd);
      $('scope-occurrence-btn').removeEventListener('click', onOccurrence);
      $('scope-series-btn').removeEventListener('click', onSeries);
      $('scope-cancel-btn').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOccurrence = () => done('occurrence');
    const onSeries     = () => done('series');
    const onCancel     = () => done(null);

    $('scope-occurrence-btn').addEventListener('click', onOccurrence);
    $('scope-series-btn').addEventListener('click', onSeries);
    $('scope-cancel-btn').addEventListener('click', onCancel);

    openDialog(bd);
  });
}

// ── Internal ──────────────────────────────────────────────────────────────────

function show() {
  openDialog(backdrop(), $('ev-title'));
}

function updateRecurrenceOptions(skipDefaultSelects = false) {
  const dateVal = $('ev-start-date').value;
  if (!dateVal) return;

  const parts = dateVal.split('-').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (isNaN(date.getTime())) return;

  const day = date.getUTCDate();
  const dayName = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][date.getUTCDay()];
  const weekNum = Math.ceil(day / 7);

  $('recur-monthly-day-lbl').textContent = `Jeden Monat am ${day}. Tag`;

  if (!skipDefaultSelects) {
    const wd = ['SU','MO','TU','WE','TH','FR','SA'][date.getUTCDay()];
    $('recur-monthly-week-idx').value = String(weekNum);
    $('recur-monthly-weekday').value = wd;

    // Re-sync BYDAY checkboxes when start date changes, but ONLY in create
    // mode (_currentEvent === null).  In edit mode the checkboxes were
    // populated from the existing RRULE (e.g. BYDAY=WE); overwriting them on
    // a start-date change would silently move the series to the wrong weekday
    // (Issue #91).  Multi-day manual selections are always preserved.
    const checkedBoxes = [...document.querySelectorAll('.recur-byday:checked')];
    if (_currentEvent === null && checkedBoxes.length <= 1) {
      document.querySelectorAll('.recur-byday').forEach(cb => cb.checked = false);
      const cb = document.querySelector(`.recur-byday[value="${wd}"]`);
      if (cb) cb.checked = true;
    }
  }

  const freq = $('ev-recurrence').value;
  $('recur-weekly-days').classList.toggle('hidden', freq !== 'WEEKLY');
  $('recur-monthly-opts').classList.toggle('hidden', freq !== 'MONTHLY');
  $('recur-end-section').classList.toggle('hidden', freq === '');
}

function resetForm() {
  _recurrenceTouched = false;
  form().reset();
  $('ev-uid').value  = '';
  $('ev-href').value = '';
  $('ev-etag').value = '';
  $('ev-recurrence').value = '';
  if ($('ev-alarm')) {
    Array.from($('ev-alarm').options).forEach(opt => {
      if (opt.dataset && opt.dataset.customAlarm === 'true') {
        opt.remove();
      }
    });
    $('ev-alarm').value = '';
  }

  if ($('ev-attachment-url')) $('ev-attachment-url').value = '';
  if ($('ev-attachment-name')) $('ev-attachment-name').value = '';
  $('event-form-error').classList.add('hidden');
  $('ev-attendee-list').innerHTML = '';

  document.querySelectorAll('.recur-byday').forEach(cb => cb.checked = false);
  const byMonthDayRadio = document.querySelector('input[name="recur-monthly-type"][value="BYMONTHDAY"]');
  if (byMonthDayRadio) byMonthDayRadio.checked = true;

  // Reset recurrence end controls
  const neverRadio = document.querySelector('input[name="recur-end-type"][value="NEVER"]');
  if (neverRadio) neverRadio.checked = true;
  $('recur-end-date').value = '';
  $('recur-end-count').value = '10';

  const activeCurrentDate = store.get('currentDate');
  const d = activeCurrentDate ? new Date(activeCurrentDate) : new Date();
  $('ev-start-date').value = toInputDate(d, null, true);
  $('ev-end-date').value   = toInputDate(d, null, true);
  updateAlldayUI(false);
  setButtonLoading('event-save-btn', false);

  setFormDisabled(false);
  const warningEl = $('event-modal-warning');
  if (warningEl) warningEl.classList.add('hidden');
}

function updateAlldayUI(allDay) {
  $('ev-start-time-group').style.display = allDay ? 'none' : '';
  $('ev-end-time-group').style.display   = allDay ? 'none' : '';
  $('ev-start-tz-group').style.display   = allDay ? 'none' : '';
  $('ev-end-tz-group').style.display     = allDay ? 'none' : '';
}

function populateCalendarSelect(selectedId) {
  const sel = $('ev-calendar');
  if (!sel) return;
  const cals = store.get('calendars') || [];
  
  // For creating a new event (selectedId is not provided), we should only show writable calendars!
  const isEditing = !!_currentEvent;
  const filteredCals = isEditing ? cals : cals.filter(c => !c.readOnly);
  const targetId = selectedId || (filteredCals[0] ? filteredCals[0].id : '');

  sel.innerHTML = '';
  if (filteredCals.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— Kein beschreibbarer Kalender verfügbar —';
    sel.appendChild(opt);
  } else {
    filteredCals.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name + (c.readOnly ? ' (schreibgeschützt)' : '');
      if (c.id === targetId) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    });
  }
}

function setFormDisabled(disabled) {
  const formEl = form();
  if (!formEl) return;
  const elements = formEl.querySelectorAll('input, select, textarea, button:not(#event-cancel-btn):not(#event-modal-close)');
  elements.forEach(el => {
    if (disabled) {
      el.setAttribute('disabled', 'disabled');
    } else {
      el.removeAttribute('disabled');
    }
  });
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
  
  const getPartMap = (d) => {
    const parts = formatter.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.hour === '24') map.hour = '00';
    return map;
  };

  const partMap = getPartMap(temp);
  const localIso = `${partMap.year}-${partMap.month}-${partMap.day}T${partMap.hour}:${partMap.minute}:${partMap.second}.000Z`;
  const localTemp = new Date(localIso);
  const diff = temp.getTime() - localTemp.getTime();
  const targetMs = temp.getTime() + diff;

  // Re-check targetMs in target timeZone to handle DST changeover offset shifts
  const targetPartMap = getPartMap(new Date(targetMs));
  const targetLocalIso = `${targetPartMap.year}-${targetPartMap.month}-${targetPartMap.day}T${targetPartMap.hour}:${targetPartMap.minute}:${targetPartMap.second}.000Z`;
  const targetLocalTemp = new Date(targetLocalIso);
  const secondDiff = temp.getTime() - targetLocalTemp.getTime();

  return new Date(targetMs + secondDiff);
}

  let startUtc, endUtc;
  const startTimeZone = $('ev-start-tz').value;
  const endTimeZone   = $('ev-end-tz').value;

  if (allDay) {
    const sDate = new Date(startDateVal + 'T00:00:00.000Z');
    let eDate = new Date(endDateVal + 'T00:00:00.000Z');
    if (isNaN(eDate.getTime()) || eDate < sDate) eDate = new Date(sDate);
    eDate.setUTCDate(eDate.getUTCDate() + 1);
    startUtc = sDate.toISOString();
    endUtc   = eDate.toISOString();
  } else {
    const startTimeVal = $('ev-start-time').value || '00:00';
    const endTimeVal   = $('ev-end-time').value   || '01:00';
    startUtc = getUtcDate(startDateVal, startTimeVal, startTimeZone).toISOString();
    endUtc   = getUtcDate(endDateVal, endTimeVal, endTimeZone).toISOString();
  }

  let recurrence = null;
  if (_currentEvent && typeof _currentEvent.recurrence === 'string' && _currentEvent.recurrence.trim() !== '' && !_recurrenceTouched) {
    recurrence = _currentEvent.recurrence;
  } else {
    const recurrenceVal = $('ev-recurrence').value;
    if (recurrenceVal === 'DAILY') {
      recurrence = 'FREQ=DAILY';
    } else if (recurrenceVal === 'YEARLY') {
      recurrence = 'FREQ=YEARLY';
    } else if (recurrenceVal === 'WEEKLY') {
      const byday = [...document.querySelectorAll('.recur-byday:checked')].map(cb => cb.value).join(',');
      recurrence = byday ? `FREQ=WEEKLY;BYDAY=${byday}` : 'FREQ=WEEKLY';
    } else if (recurrenceVal === 'MONTHLY') {
      const parts = startDateVal.split('-').map(Number);
      const startD = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      if (!isNaN(startD.getTime())) {
        const typeEl = document.querySelector('input[name="recur-monthly-type"]:checked');
        const type = typeEl ? typeEl.value : 'BYMONTHDAY';
        if (type === 'BYMONTHDAY') {
          recurrence = `FREQ=MONTHLY;BYMONTHDAY=${startD.getUTCDate()}`;
        } else if (type === 'BYDAY') {
          const wd = ['SU','MO','TU','WE','TH','FR','SA'][startD.getUTCDay()];
          const weekNum = Math.ceil(startD.getUTCDate() / 7);
          recurrence = `FREQ=MONTHLY;BYDAY=${weekNum}${wd}`;
        }
      } else {
        recurrence = 'FREQ=MONTHLY';
      }
    }

    if (recurrence) {
      const endTypeEl = document.querySelector('input[name="recur-end-type"]:checked');
      const endType = endTypeEl ? endTypeEl.value : 'NEVER';
      if (endType === 'UNTIL') {
        const untilDateVal = $('recur-end-date').value;
        if (untilDateVal) {
          const datePart = untilDateVal.replace(/-/g, '');
          recurrence += `;UNTIL=${datePart}T235959Z`;
        }
      } else if (endType === 'COUNT') {
        const countVal = $('recur-end-count').value;
        if (countVal && parseInt(countVal, 10) > 0) {
          recurrence += `;COUNT=${parseInt(countVal, 10)}`;
        }
      }
    }

    if (_currentEvent && typeof _currentEvent.recurrence === 'string' && _currentEvent.recurrence.trim() !== '' && recurrence) {
      const origFreqMatch = _currentEvent.recurrence.match(/FREQ=([A-Z]+)/);
      const newFreqMatch = recurrence.match(/FREQ=([A-Z]+)/);
      if (origFreqMatch && newFreqMatch && origFreqMatch[1] === newFreqMatch[1]) {
        const origParts = _currentEvent.recurrence.split(';');
        const newParts = recurrence.split(';');
        const newKeys = new Set(newParts.map(p => p.split('=')[0]));
        const mergedParts = [...newParts];
        origParts.forEach(part => {
          const key = part.split('=')[0];
          if (!newKeys.has(key) && key !== '') {
            mergedParts.push(part);
          }
        });
        recurrence = mergedParts.join(';');
      }
    }
  }

  const alarmTrigger = $('ev-alarm') ? $('ev-alarm').value : '';
  const alarms = alarmTrigger ? [{ action: 'DISPLAY', trigger: alarmTrigger, description: $('ev-title').value.trim() || 'Erinnerung' }] : [];

  const attachUrl = $('ev-attachment-url') ? $('ev-attachment-url').value.trim() : '';
  const attachName = $('ev-attachment-name') ? $('ev-attachment-name').value.trim() : '';
  const attachments = attachUrl ? [{ url: attachUrl, name: attachName || attachUrl.split('/').pop() || 'Anhang' }] : [];

  const rawCatVal = $('ev-categories') ? $('ev-categories').value.trim() : '';
  const categories = rawCatVal ? rawCatVal.split(',').map(c => c.trim()).filter(Boolean) : [];

  const payload = {
    calendarId:  $('ev-calendar').value,
    title:       $('ev-title').value.trim(),
    start:       startUtc,
    end:         endUtc,
    allDay,
    location:    $('ev-location').value.trim()    || null,
    description: $('ev-description').value.trim() || null,
    categories,
    attendees:   collectAttendees(),
    recurrence,
    alarms,
    attachments,
    startTimeZone: allDay ? null : startTimeZone,
    endTimeZone:   allDay ? null : endTimeZone
  };

  setButtonLoading('event-save-btn', true);
  $('event-form-error').classList.add('hidden');

  // Editing an instance of a recurring series: ask for the scope first
  if (_currentEvent && _currentEvent.recurrenceId) {
    setButtonLoading('event-save-btn', false);
    const scope = await chooseRecurrenceScope('Diese Änderung anwenden auf:');
    if (!scope) return;
    if (scope === 'occurrence') {
      payload.scope        = 'occurrence';
      payload.recurrenceId = _currentEvent.recurrenceId;
      payload.recurrence   = null; // a detached exception carries no RRULE
    }
    setButtonLoading('event-save-btn', true);
  }

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

  let scope = 'series';
  if (_currentEvent.recurrenceId) {
    scope = await chooseRecurrenceScope(`„${_currentEvent.title}“ löschen:`);
    if (!scope) return;
  } else {
    if (!(await confirmDialog(`„${_currentEvent.title}“ wirklich löschen?`))) return;
  }

  setButtonLoading('event-save-btn', true);
  try {
    const targetUid = _currentEvent.masterUid || _currentEvent.uid;
    await EventsAPI.remove(targetUid, {
      calendarId: _currentEvent.calendarId,
      etag:       _currentEvent.etag,
      href:       _currentEvent.href,
      ...(scope === 'occurrence' ? { scope, recurrenceId: _currentEvent.recurrenceId } : {})
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

  const markRecurrenceTouched = () => { _recurrenceTouched = true; };

  $('ev-allday').addEventListener('change', e => updateAlldayUI(e.target.checked));
  $('ev-recurrence').addEventListener('change', () => {
    markRecurrenceTouched();
    updateRecurrenceOptions(false);
  });
  $('ev-start-date').addEventListener('change', () => updateRecurrenceOptions(false));
  $('add-attendee-btn').addEventListener('click', handleAddAttendee);

  document.querySelectorAll('.recur-byday').forEach(cb => cb.addEventListener('change', markRecurrenceTouched));
  document.querySelectorAll('input[name="recur-monthly-type"]').forEach(r => r.addEventListener('change', markRecurrenceTouched));
  if ($('recur-monthly-week-idx')) $('recur-monthly-week-idx').addEventListener('change', markRecurrenceTouched);
  if ($('recur-monthly-weekday')) $('recur-monthly-weekday').addEventListener('change', markRecurrenceTouched);
  document.querySelectorAll('input[name="recur-end-type"]').forEach(r => r.addEventListener('change', markRecurrenceTouched));
  if ($('recur-end-date')) {
    $('recur-end-date').addEventListener('input', markRecurrenceTouched);
    $('recur-end-date').addEventListener('change', markRecurrenceTouched);
  }
  if ($('recur-end-count')) {
    $('recur-end-count').addEventListener('input', markRecurrenceTouched);
    $('recur-end-count').addEventListener('change', markRecurrenceTouched);
  }

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
      btn.setAttribute('aria-label', input.type === 'password' ? 'Passwort anzeigen' : 'Passwort verbergen');
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

function toInputDate(d, tzid, isUtcDate = false) {
  if (isUtcDate || (!tzid && typeof d === 'string' && (/^\d{4}-\d{2}-\d{2}/.test(d) || d.endsWith('Z')))) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const dateObj = new Date(d);
    if (isNaN(dateObj.getTime())) return '';
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
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
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const dateObj = new Date(d);
  if (!isNaN(dateObj.getTime())) {
    if (dateObj.getUTCHours() === 0 && dateObj.getUTCMinutes() === 0 && dateObj.getUTCSeconds() === 0 && dateObj.getUTCMilliseconds() === 0) {
      const y = dateObj.getUTCFullYear();
      const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    if (dateObj.getHours() === 0 && dateObj.getMinutes() === 0 && dateObj.getSeconds() === 0 && dateObj.getMilliseconds() === 0) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
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
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
