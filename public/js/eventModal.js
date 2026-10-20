/**
 * eventModal.js — Event create/edit modal controller.
 */

import { store, calendarById } from './store.js';
import { fillCalendarSelect, holdsEvents } from './calendarLabels.js';
import { EventsAPI } from './api.js';
import { showToast, showUndoToast } from './app.js';
import { openDialog, closeDialog, confirmDialog, isDialogOpen } from './dialogFocus.js';
import { requestNotificationPermission } from './notifications.js';
import { createReminderEditor, formatAlarmTriggerLabel } from './reminderEditor.js';
import { createTemplatePicker, templateAlarms } from './templates.js';
import { allTimeZones, localTimeZone } from './timezones.js';
import { createLocationLookup } from './geoLookup.js';
import { createConferenceField } from './conference.js';

export { formatAlarmTriggerLabel };

let _onSaved  = null;
let _onDeleted = null;
// Issue #174: onPending(preview, replacesUid) shows an event while its save runs
// and returns a token; onSettled(token) removes that preview after a failure.
let _onPending = null;
let _onSettled = null;
let _formGeneration = 0; // counts openings, so a failed save knows the form still holds its entries
let _currentEvent = null; // null = create mode, object = edit mode
let _recurrenceTouched = false;
let _reminders = null; // #508: reminder list editor, created in initEventModal
let _templates = null; // #515: "Neu aus Vorlage" picker, created in initEventModal
let _location = null; // #512: location field with address autocomplete and map preview
let _conference = null; // #521: "Videokonferenz hinzufügen" and the event's video link

// ── DOM refs (lazily grabbed) ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function backdrop()  { return $('event-modal-backdrop'); }
function form()      { return $('event-form'); }

// #516: start and end each get a zone (a flight from Berlin to New York). The default is the
// user's zone and the selects stay folded away; an event whose zones differ from it opens them.
let _tzExpanded = false;

function populateTimezoneSelects(selectedStartTz, selectedEndTz) {
  const localTz = localTimeZone();
  const startTz = selectedStartTz || localTz;
  const endTz   = selectedEndTz   || localTz;

  // A TZID another client defined in its own VTIMEZONE is listed too, so it is kept on save.
  const tzs = [...new Set([...allTimeZones(), startTz, endTz])].sort();
  for (const sel of [$('ev-start-tz'), $('ev-end-tz')]) {
    sel.replaceChildren(...tzs.map(tz => new Option(tz, tz)));
  }
  $('ev-start-tz').value = startTz;
  $('ev-end-tz').value   = endTz;

  setTimezonesExpanded(startTz !== localTz || endTz !== localTz);
}

function setTimezonesExpanded(expanded) {
  _tzExpanded = expanded;
  updateAlldayUI($('ev-allday').checked);
}

function updateTimezoneToggleLabel() {
  const startTz = $('ev-start-tz').value;
  const endTz   = $('ev-end-tz').value;
  $('ev-tz-toggle').textContent = _tzExpanded ? 'Zeitzonen ausblenden'
    : startTz === endTz ? `Zeitzone: ${startTz}` : `Zeitzonen: ${startTz} → ${endTz}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

// `range` ({ start, end, allDay }, as drawn by dragging on empty space, #576) presets start and end.
export function openCreateModal(defaultDate, callbacks, range = null) {
  _currentEvent = null;
  setCallbacks(callbacks);

  resetForm();
  $('event-modal-title').textContent = 'Neuer Termin';
  $('delete-event-btn').style.display = 'none';
  $('event-duplicate-btn').classList.add('hidden');
  $('event-save-btn').style.display = '';
  _templates.show();

  const activeCurrentDate = store.get('currentDate');
  const d = defaultDate ? new Date(defaultDate) : (activeCurrentDate ? new Date(activeCurrentDate) : new Date());
  $('ev-start-date').value = toLocalInputDate(d);
  $('ev-end-date').value   = toLocalInputDate(d);

  if (range) {
    $('ev-allday').checked = range.allDay;
    updateAlldayUI(range.allDay);
    if (range.allDay) {
      // The form shows the last day; the range's end is the exclusive day after it.
      const last = new Date(`${range.end}T00:00:00.000Z`);
      last.setUTCDate(last.getUTCDate() - 1);
      $('ev-start-date').value = range.start;
      $('ev-end-date').value   = toInputDate(last, null, true);
    } else {
      const start = new Date(range.start);
      const end = new Date(range.end);
      $('ev-start-date').value = toLocalInputDate(start);
      $('ev-start-time').value = toInputTime(start);
      $('ev-end-date').value   = toLocalInputDate(end);
      $('ev-end-time').value   = toInputTime(end);
    }
  } else if (defaultDate && (d.getHours() !== 0 || d.getMinutes() !== 0)) {
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
  setCallbacks(callbacks);

  $('event-modal-title').textContent = 'Termin bearbeiten';

  resetForm();
  populateCalendarSelect(event.calendarId);

  const cal = (store.get('calendars') || []).find(c => c.id === event.calendarId);
  const isReadOnly = event.readOnly || event.isSubscription || (cal ? !!cal.readOnly : false);

  $('event-save-btn').style.display = isReadOnly ? 'none' : '';
  $('delete-event-btn').style.display = isReadOnly ? 'none' : 'block';
  $('event-duplicate-btn').classList.remove('hidden');
  _templates.hide();

  let warningEl = $('event-modal-warning');
  if (!warningEl) {
    warningEl = document.createElement('div');
    warningEl.id = 'event-modal-warning';
    warningEl.style.cssText = 'font-size:0.8rem;color:var(--danger);padding:8px 12px;background:#fee2e2;border-radius:4px;margin-bottom:12px;font-weight:600;line-height:1.4;';
    const fm = form();
    fm.parentNode.insertBefore(warningEl, fm);
  }

  if (isReadOnly) {
    warningEl.textContent = event.isSubscription
      ? 'Dieser Termin stammt aus einem schreibgeschützten Webcal-Abonnement.'
      : 'Dieser Termin ist schreibgeschützt (Kalender wurde schreibgeschützt geteilt).';
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
  _location.set(event.location, event.geo);
  $('ev-description').value = event.description || '';
  _conference.set(event.conference);
  if ($('ev-categories')) {
    const catList = Array.isArray(event.categories) ? event.categories : [];
    $('ev-categories').value = catList.join(', ');
  }
  $('ev-transp').value = event.transp || 'OPAQUE';
  $('ev-class').value  = event.classification || 'PUBLIC';

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
  const intervalMatch = rruleStr.match(/(?:^|;)INTERVAL=(\d+)/);
  $('recur-interval').value = intervalMatch ? intervalMatch[1] : '1';

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
    } else {
      const startDateVal = $('ev-start-date').value;
      if (startDateVal) {
        const parts = startDateVal.split('-').map(Number);
        if (parts.length >= 3 && !parts.some(isNaN)) {
          const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
          const dayCode = ['SU','MO','TU','WE','TH','FR','SA'][d.getUTCDay()];
          const cb = document.querySelector(`.recur-byday[value="${dayCode}"]`);
          if (cb) cb.checked = true;
        }
      }
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

  const eventAlarms = Array.isArray(event.alarms) ? event.alarms : [];
  _reminders.setAlarms(eventAlarms);


  // Attachments
  const firstAttach = (event.attachments && event.attachments.length > 0) ? event.attachments[0] : null;
  if ($('ev-attachment-url')) $('ev-attachment-url').value = firstAttach ? (firstAttach.url || '') : '';
  if ($('ev-attachment-name')) $('ev-attachment-name').value = firstAttach ? (firstAttach.name || '') : '';

  // #506: a collapsed section the event has content in opens by itself.
  $('ev-section-recurrence').open = Boolean(event.recurrence);
  $('ev-section-alarm').open      = eventAlarms.length > 0;
  $('ev-section-attendees').open  = (event.attendees || []).length > 0;
  $('ev-section-link').open       = Boolean(firstAttach);
  $('ev-section-more').open       = (event.categories || []).length > 0
    || $('ev-transp').value !== 'OPAQUE' || $('ev-class').value !== 'PUBLIC';

  _recurrenceTouched = false;
  show();
}

export function closeModal() {
  closeDialog(backdrop());
  _currentEvent = null;
}

/**
 * #515: "Duplizieren" — the dialog keeps the fields and turns into a new event, which gets its own
 * UID when it is saved. Nothing is stored (and nobody invited) before "Speichern".
 */
export function openDuplicateModal(event, callbacks) {
  openEditModal(event, callbacks);
  duplicateCurrent();
}

function duplicateCurrent() {
  const source = _currentEvent;
  _currentEvent = null;
  _formGeneration++;
  $('event-modal-title').textContent = 'Termin duplizieren';
  $('ev-uid').value  = '';
  $('ev-href').value = '';
  $('ev-etag').value = '';
  $('delete-event-btn').style.display = 'none';
  $('event-duplicate-btn').classList.add('hidden');
  $('event-save-btn').style.display = '';
  $('event-modal-warning')?.classList.add('hidden');
  setFormDisabled(false);
  // The copy goes into a writable calendar: the source's one if it is, the first otherwise.
  const writable = (store.get('calendars') || []).some(c => c.id === source.calendarId && !c.readOnly);
  populateCalendarSelect(writable ? source.calendarId : undefined);
  // The copy's attendees have not answered it yet.
  renderAttendeeList(collectAttendees().map(a => ({ ...a, status: 'NEEDS-ACTION' })));
  $('ev-title').focus();
}

// #515: the dialog's fields without date, time and recurrence, for "Als Vorlage speichern".
function templateFields() {
  const reminders = _reminders.collect($('ev-title').value.trim() || 'Erinnerung');
  if (reminders.error) return reminders;
  const attachUrl = $('ev-attachment-url').value.trim();
  const attachName = $('ev-attachment-name').value.trim();
  const rawCatVal = $('ev-categories').value.trim();
  return {
    fields: {
      title:          $('ev-title').value.trim(),
      calendarId:     $('ev-calendar').value || null,
      allDay:         $('ev-allday').checked,
      location:       $('ev-location').value.trim() || null,
      description:    $('ev-description').value.trim() || null,
      categories:     rawCatVal ? rawCatVal.split(',').map(c => c.trim()).filter(Boolean) : [],
      attendees:      collectAttendees().map(({ name, email }) => ({ name, email })),
      alarms:         templateAlarms(reminders.alarms),
      attachments:    attachUrl ? [{ url: attachUrl, name: attachName || attachUrl.split('/').pop() || 'Link' }] : [],
      transp:         $('ev-transp').value,
      classification: $('ev-class').value,
    }
  };
}

async function saveAsTemplate() {
  if (!$('ev-title').value.trim()) {
    showError('Bitte gib einen Titel ein.');
    return;
  }
  const { fields, error } = templateFields();
  if (error) {
    $('ev-section-alarm').open = true;
    showError(error);
    return;
  }
  $('event-form-error').classList.add('hidden');
  await _templates.save(fields);
}

// #515: "Neu aus Vorlage" fills the new event's fields; date and time stay as the dialog set them.
function applyTemplate(fields) {
  $('ev-title').value = fields.title || '';
  if (fields.calendarId && [...$('ev-calendar').options].some(o => o.value === fields.calendarId)) {
    $('ev-calendar').value = fields.calendarId;
  }
  $('ev-allday').checked = Boolean(fields.allDay);
  updateAlldayUI(Boolean(fields.allDay));
  _location.set(fields.location, null);
  $('ev-description').value = fields.description || '';
  _conference.set(null);
  $('ev-categories').value  = (fields.categories || []).join(', ');
  renderAttendeeList((fields.attendees || []).map(a => ({ ...a, status: 'NEEDS-ACTION' })));
  _reminders.setAlarms(fields.alarms || []);
  const attach = (fields.attachments || [])[0];
  $('ev-attachment-url').value  = attach ? attach.url : '';
  $('ev-attachment-name').value = attach ? attach.name : '';
  $('ev-transp').value = fields.transp || 'OPAQUE';
  $('ev-class').value  = fields.classification || 'PUBLIC';
  $('ev-section-alarm').open     = (fields.alarms || []).length > 0;
  $('ev-section-attendees').open = (fields.attendees || []).length > 0;
  $('ev-section-link').open      = Boolean(attach);
  $('ev-section-more').open      = (fields.categories || []).length > 0
    || $('ev-transp').value !== 'OPAQUE' || $('ev-class').value !== 'PUBLIC';
}

/**
 * Ask whether an action on a recurring event applies to a single occurrence,
 * this and all following ones (#346), or the whole series.
 * Resolves 'occurrence' | 'following' | 'series' | null (cancelled).
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
      $('scope-following-btn').removeEventListener('click', onFollowing);
      $('scope-series-btn').removeEventListener('click', onSeries);
      $('scope-cancel-btn').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOccurrence = () => done('occurrence');
    const onFollowing  = () => done('following');
    const onSeries     = () => done('series');
    const onCancel     = () => done(null);

    $('scope-occurrence-btn').addEventListener('click', onOccurrence);
    $('scope-following-btn').addEventListener('click', onFollowing);
    $('scope-series-btn').addEventListener('click', onSeries);
    $('scope-cancel-btn').addEventListener('click', onCancel);

    openDialog(bd);
  });
}

// ── Internal ──────────────────────────────────────────────────────────────────

function setCallbacks(callbacks) {
  _formGeneration++;
  _onSaved   = callbacks?.onSaved;
  _onDeleted = callbacks?.onDeleted;
  _onPending = callbacks?.onPending;
  _onSettled = callbacks?.onSettled;
}

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

    // Re-sync BYDAY checkboxes when start date changes across both create and edit
    // modes when a single day (or default) is selected (Issue #91).
    // Multi-day manual selections (e.g. MO,WE,FR) are always preserved.
    const checkedBoxes = [...document.querySelectorAll('.recur-byday:checked')];
    if (checkedBoxes.length <= 1) {
      document.querySelectorAll('.recur-byday').forEach(cb => cb.checked = false);
      const cb = document.querySelector(`.recur-byday[value="${wd}"]`);
      if (cb) cb.checked = true;
    }
  }

  const freq = $('ev-recurrence').value;
  $('recur-interval-group').classList.toggle('hidden', freq === '');
  updateIntervalLabel();
  $('recur-weekly-days').classList.toggle('hidden', freq !== 'WEEKLY');
  $('recur-monthly-opts').classList.toggle('hidden', freq !== 'MONTHLY');
  $('recur-end-section').classList.toggle('hidden', freq === '');
}

// "Jede Woche" for INTERVAL=1, "Alle 3 Wochen" otherwise (#507).
const INTERVAL_WORDS = {
  DAILY:   { every: 'Jeden', one: 'Tag',   many: 'Tage' },
  WEEKLY:  { every: 'Jede',  one: 'Woche', many: 'Wochen' },
  MONTHLY: { every: 'Jeden', one: 'Monat', many: 'Monate' },
  YEARLY:  { every: 'Jedes', one: 'Jahr',  many: 'Jahre' },
};

function updateIntervalLabel() {
  const words = INTERVAL_WORDS[$('ev-recurrence').value];
  if (!words) return;
  const single = $('recur-interval').value === '1';
  $('recur-interval-prefix').textContent = single ? words.every : 'Alle';
  $('recur-interval-unit').textContent = single ? words.one : words.many;
}

function resetForm() {
  _recurrenceTouched = false;
  form().reset();
  $('ev-uid').value  = '';
  $('ev-href').value = '';
  $('ev-etag').value = '';
  $('ev-recurrence').value = '';
  _reminders.setAlarms([]);

  if ($('ev-attachment-url')) $('ev-attachment-url').value = '';
  if ($('ev-attachment-name')) $('ev-attachment-name').value = '';
  form().querySelectorAll('details.form-section').forEach(section => { section.open = false; });
  $('event-form-error').classList.add('hidden');
  $('ev-attendee-list').innerHTML = '';
  _location.set('', null);
  _conference.set(null);

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
  $('ev-start-date').value = toLocalInputDate(d);
  $('ev-end-date').value   = toLocalInputDate(d);
  updateAlldayUI(false);
  setButtonLoading('event-save-btn', false);

  setFormDisabled(false);
  const warningEl = $('event-modal-warning');
  if (warningEl) warningEl.classList.add('hidden');
}

function updateAlldayUI(allDay) {
  $('ev-start-time-group').style.display = allDay ? 'none' : '';
  $('ev-end-time-group').style.display   = allDay ? 'none' : '';
  $('ev-start-tz-group').classList.toggle('hidden', allDay || !_tzExpanded);
  $('ev-end-tz-group').classList.toggle('hidden', allDay || !_tzExpanded);
  $('ev-tz-toggle-row').classList.toggle('hidden', allDay);
  $('ev-tz-toggle').setAttribute('aria-expanded', String(_tzExpanded));
  updateTimezoneToggleLabel();
}

function populateCalendarSelect(selectedId) {
  const sel = $('ev-calendar');
  if (!sel) return;
  const cals = store.get('calendars') || [];
  
  // For creating a new event (selectedId is not provided), we should only show writable calendars!
  const isEditing = !!_currentEvent;
  // #500: events go into collections holding VEVENT; an edited event keeps its own one listed.
  const eventCals = cals.filter(c => holdsEvents(c) || (isEditing && c.id === _currentEvent.calendarId));
  const filteredCals = isEditing ? eventCals : eventCals.filter(c => !c.readOnly);
  const targetId = selectedId || (filteredCals[0] ? filteredCals[0].id : '');

  sel.innerHTML = '';
  if (filteredCals.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— Kein beschreibbarer Kalender verfügbar —';
    sel.appendChild(opt);
  } else {
    fillCalendarSelect(sel, filteredCals, (opt, c) => {
      if (c.readOnly) opt.textContent += ' (schreibgeschützt)';
      if (c.id === targetId) {
        opt.selected = true;
      }
    });
  }
}

function setFormDisabled(disabled) {
  const formEl = form();
  if (!formEl) return;
  // A read-only event can still be duplicated into a writable calendar or kept as a template (#515).
  const elements = formEl.querySelectorAll('input, select, textarea, button:not(#event-cancel-btn):not(#event-modal-close):not(#event-duplicate-btn):not(#event-template-btn)');
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
      <span class="attendee-status ${attendeeStatus(a.status)}">${statusLabel(attendeeStatus(a.status))}</span>
      <button type="button" class="attendee-remove" data-idx="${i}" aria-label="Entfernen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
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
  const intervalVal = $('recur-interval').value;
  if ($('ev-recurrence').value && !/^[1-9]\d*$/.test(intervalVal)) {
    showError('Bitte gib als Wiederholungsabstand eine ganze Zahl ab 1 ein.');
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

  let targetTz = timeZone || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: targetTz });
  } catch (e) {
    targetTz = 'UTC';
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: targetTz,
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
      // INTERVAL=1 is the RFC 5545 default and is left out; any other value was validated above.
      const interval = Number(intervalVal);
      if (interval > 1) recurrence = recurrence.replace(/^FREQ=[A-Z]+/, m => `${m};INTERVAL=${interval}`);

      const endTypeEl = document.querySelector('input[name="recur-end-type"]:checked');
      const endType = endTypeEl ? endTypeEl.value : 'NEVER';
      if (endType === 'UNTIL') {
        const untilDateVal = $('recur-end-date').value;
        if (untilDateVal) {
          const datePart = untilDateVal.replace(/-/g, '');
          let untilVal = `${datePart}T235959Z`;
          if (_currentEvent && typeof _currentEvent.recurrence === 'string') {
            const origUntilMatch = _currentEvent.recurrence.match(/UNTIL=([^;]+)/);
            if (origUntilMatch) {
              const origUntil = origUntilMatch[1];
              if (origUntil.startsWith(datePart)) {
                untilVal = origUntil;
              }
            }
          }
          recurrence += `;UNTIL=${untilVal}`;
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
          // INTERVAL is shown in the dialog, so a dropped one was set back to 1 (#507).
          if (!newKeys.has(key) && key !== '' && key !== 'INTERVAL') {
            mergedParts.push(part);
          }
        });
        recurrence = mergedParts.join(';');
      }
    }
  }

  const reminders = _reminders.collect($('ev-title').value.trim() || 'Erinnerung');
  if (reminders.error) {
    $('ev-section-alarm').open = true;
    showError(reminders.error);
    return;
  }
  const alarms = reminders.alarms;

  const attachUrl = $('ev-attachment-url') ? $('ev-attachment-url').value.trim() : '';
  const attachName = $('ev-attachment-name') ? $('ev-attachment-name').value.trim() : '';
  const attachments = attachUrl ? [{ url: attachUrl, name: attachName || attachUrl.split('/').pop() || 'Link' }] : [];

  const rawCatVal = $('ev-categories') ? $('ev-categories').value.trim() : '';
  const categories = rawCatVal ? rawCatVal.split(',').map(c => c.trim()).filter(Boolean) : [];

  const payload = {
    calendarId:  $('ev-calendar').value,
    title:       $('ev-title').value.trim(),
    start:       startUtc,
    end:         endUtc,
    allDay,
    location:    $('ev-location').value.trim()    || null,
    geo:         _location.geo(),
    conference:  _conference.get(),
    description: $('ev-description').value.trim() || null,
    categories,
    attendees:   collectAttendees(),
    recurrence,
    alarms,
    attachments,
    transp:         $('ev-transp').value,
    classification: $('ev-class').value,
    startTimeZone: allDay ? null : startTimeZone,
    endTimeZone:   allDay ? null : endTimeZone
  };

  setButtonLoading('event-save-btn', true);
  $('event-form-error').classList.add('hidden');

  if (alarms.length > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      await requestNotificationPermission();
    } catch (e) {
      console.warn('[eventModal] Notification permission request error:', e);
    }
  }

  // Editing an instance of a recurring series: ask for the scope first
  const recurrenceId = _currentEvent?.recurrenceId || (_currentEvent?.uid && _currentEvent.uid.includes('::') ? _currentEvent.uid.split('::')[1] : null);
  // A series changes calendar only as a whole, with its exceptions (#494).
  const moving = Boolean(_currentEvent && payload.calendarId !== _currentEvent.calendarId);
  if (_currentEvent && recurrenceId && moving) {
    payload.scope        = 'series';
    payload.recurrenceId = recurrenceId;
  } else if (_currentEvent && recurrenceId) {
    setButtonLoading('event-save-btn', false);
    const scope = await chooseRecurrenceScope('Diese Änderung anwenden auf:');
    if (!scope) return;
    if (scope === 'occurrence') {
      payload.scope        = 'occurrence';
      payload.recurrenceId = recurrenceId;
      payload.recurrence   = null; // a detached exception carries no RRULE
    } else {
      payload.scope        = scope;
      payload.recurrenceId = recurrenceId;
    }
    setButtonLoading('event-save-btn', true);
  }

  // Issue #174: optimistic save. Saving into a large Radicale collection takes a
  // noticeable moment, so the dialog closes and the event shows at once while
  // the request runs. On failure the preview is removed again, a toast says
  // what was not saved, and the dialog reopens with the entries kept.
  const original  = _currentEvent;
  const callbacks = { onSaved: _onSaved, onDeleted: _onDeleted, onPending: _onPending, onSettled: _onSettled };
  const formGeneration = _formGeneration;
  if (original) {
    payload.uid  = original.masterUid || (original.uid ? original.uid.split('::')[0] : '');
    payload.href = original.href;
    payload.etag = original.etag;
    payload.sourceCalendarId = original.calendarId;
  }
  const token = callbacks.onPending?.(previewEvent(payload, original), original ? original.uid : null);
  closeModal();
  setButtonLoading('event-save-btn', false);

  try {
    const saved = original ? await EventsAPI.update(payload.uid, payload) : await EventsAPI.create(payload);
    showToast(original ? 'Termin gespeichert.' : 'Termin erstellt.', 'success');
    callbacks.onSaved?.(saved, token);
  } catch (err) {
    callbacks.onSettled?.(token);
    const reason = err.status === 409
      ? 'Konflikt: Der Termin wurde von einem anderen Client geändert. Seite neu laden.'
      : err.message;
    const title = `„${payload.title || 'Ohne Titel'}“`;
    showToast(original
      ? `Die Änderung an ${title} wurde nicht gespeichert und ist zurückgenommen. ${reason}`
      : `Der Termin ${title} wurde nicht gespeichert und ist wieder entfernt. ${reason}`, 'error');
    // The form still holds the entries unless another event was opened since.
    if (formGeneration === _formGeneration && !isDialogOpen(backdrop())) {
      _currentEvent = original;
      _onSaved = callbacks.onSaved;
      _onDeleted = callbacks.onDeleted;
      _onPending = callbacks.onPending;
      _onSettled = callbacks.onSettled;
      show();
      showError(reason);
    }
  }
}

// The event as the views draw it, from the payload being saved.
function previewEvent(payload, original) {
  return {
    ...(original || {}),
    uid: original ? original.uid : `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    calendarId: payload.calendarId,
    title: payload.title,
    start: payload.start,
    end: payload.end,
    allDay: payload.allDay,
    location: payload.location,
    geo: payload.geo,
    conference: payload.conference,
    description: payload.description,
    categories: payload.categories,
    attendees: payload.attendees,
    recurrence: payload.recurrence,
    alarms: payload.alarms,
    attachments: payload.attachments,
    transp: payload.transp,
    classification: payload.classification,
    startTimeZone: payload.startTimeZone,
    endTimeZone: payload.endTimeZone
  };
}

async function handleDelete() {
  if (!_currentEvent) return;

  let scope = 'series';
  const deleteRecurrenceId = _currentEvent.recurrenceId || (_currentEvent.uid && _currentEvent.uid.includes('::') ? _currentEvent.uid.split('::')[1] : null);
  if (deleteRecurrenceId) {
    scope = await chooseRecurrenceScope(`„${_currentEvent.title}“ löschen:`);
    if (!scope) return;
  } else {
    if (!(await confirmDialog(`„${_currentEvent.title}“ wirklich löschen?`))) return;
  }

  setButtonLoading('event-save-btn', true);
  try {
    const targetUid = _currentEvent.masterUid || (_currentEvent.uid ? _currentEvent.uid.split('::')[0] : '');
    const { trashId } = await EventsAPI.remove(targetUid, {
      calendarId: _currentEvent.calendarId,
      etag:       _currentEvent.etag,
      href:       _currentEvent.href,
      ...(scope !== 'series' ? { scope, recurrenceId: deleteRecurrenceId } : {})
    });
    closeModal();
    // A deleted occurrence is an EXDATE in the series, not a trash entry.
    if (trashId) showUndoToast('Termin gelöscht.', trashId);
    else showToast('Termin gelöscht.', 'info');
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
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
  $('event-duplicate-btn').addEventListener('click', duplicateCurrent);
  $('event-template-btn').addEventListener('click', saveAsTemplate);
  _location = createLocationLookup();
  _conference = createConferenceField();
  _templates = createTemplatePicker({
    kind: 'event',
    row: $('ev-template-row'),
    select: $('ev-template'),
    deleteBtn: $('ev-template-delete'),
    onApply: applyTemplate,
  });

  const markRecurrenceTouched = () => { _recurrenceTouched = true; };

  $('ev-allday').addEventListener('change', e => updateAlldayUI(e.target.checked));
  $('ev-tz-toggle').addEventListener('click', () => setTimezonesExpanded(!_tzExpanded));
  $('ev-start-tz').addEventListener('change', updateTimezoneToggleLabel);
  $('ev-end-tz').addEventListener('change', updateTimezoneToggleLabel);
  _reminders = createReminderEditor($('ev-reminder-list'), $('ev-add-reminder'), {
    anchor: 'START',
    anchorName: 'Beginn',
    onAdd: async () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try {
          await requestNotificationPermission();
        } catch (err) {
          console.warn('[eventModal] Notification permission request error on adding a reminder:', err);
        }
      }
    }
  });
  $('ev-recurrence').addEventListener('change', () => {
    markRecurrenceTouched();
    updateRecurrenceOptions(false);
  });
  const onStartDateChange = () => {
    markRecurrenceTouched();
    updateRecurrenceOptions(false);
  };
  $('ev-start-date').addEventListener('change', onStartDateChange);
  $('ev-start-date').addEventListener('input', onStartDateChange);
  $('add-attendee-btn').addEventListener('click', handleAddAttendee);

  document.querySelectorAll('.recur-byday').forEach(cb => cb.addEventListener('change', markRecurrenceTouched));
  document.querySelectorAll('input[name="recur-monthly-type"]').forEach(r => r.addEventListener('change', markRecurrenceTouched));
  if ($('recur-monthly-week-idx')) $('recur-monthly-week-idx').addEventListener('change', markRecurrenceTouched);
  if ($('recur-monthly-weekday')) $('recur-monthly-weekday').addEventListener('change', markRecurrenceTouched);
  document.querySelectorAll('input[name="recur-end-type"]').forEach(r => r.addEventListener('change', markRecurrenceTouched));
  $('recur-interval').addEventListener('input', () => {
    markRecurrenceTouched();
    updateIntervalLabel();
  });
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// The browser-local calendar date of a Date, e.g. the day a view or a clicked slot stands for (#254).
function toLocalInputDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
const STATUS_LABELS = { ACCEPTED: 'Zugesagt', DECLINED: 'Abgelehnt', TENTATIVE: 'Vorläufig', DELEGATED: 'Delegiert', 'NEEDS-ACTION': 'Ausstehend' };
// PARTSTAT comes from remote calendars; anything outside RFC 5545 counts as NEEDS-ACTION (#528).
function attendeeStatus(s) {
  return Object.hasOwn(STATUS_LABELS, s) ? s : 'NEEDS-ACTION';
}
function statusLabel(s) {
  return Object.hasOwn(STATUS_LABELS, s) ? STATUS_LABELS[s] : escHtml(s);
}
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
