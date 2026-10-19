/**
 * tasks.js — VTODO Tasks & Kanban Board rendering engine.
 */

import { store } from './store.js';
import { fillCalendarSelect, calendarLabel } from './calendarLabels.js';
import { TasksAPI } from './api.js';
import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';
import { showToast, showUndoToast } from './app.js';
import { createReminderEditor } from './reminderEditor.js';
import { createTemplatePicker, templateAlarms } from './templates.js';

function notifyToast(message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

// Issue #167: one numeric date format across the UI, DIN 5008 with zero-padded day and month (05.03.2027).
// A date-only due is a calendar date stored at UTC midnight; a timed due is shown in the browser's zone.
function formatDueDate(d, isDate) {
  return d.toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', ...(isDate ? { timeZone: 'UTC' } : {}),
  });
}

export function formatRecurrenceLabel(recurrence) {
  if (!recurrence) return '';
  const str = String(recurrence).replace(/^RRULE:/i, '').toUpperCase();
  if (str.includes('FREQ=DAILY')) return 'Täglich';
  if (str.includes('FREQ=WEEKLY')) return 'Wöchentlich';
  if (str.includes('FREQ=MONTHLY')) return 'Monatlich';
  if (str.includes('FREQ=YEARLY')) return 'Jährlich';
  return recurrence;
}

// Completing a task is decided server-side: for a recurring task the server
// rolls the master forward and stores the finished occurrence (#95).
// percentComplete must be 100, otherwise reconcileTaskStatus downgrades the
// COMPLETED status back to NEEDS-ACTION.
function completionPayload(task) {
  return { ...task, status: 'COMPLETED', percentComplete: 100 };
}

// The board has one lane per VTODO STATUS of RFC 5545 (#499).
const KANBAN_LANES = [
  { status: 'NEEDS-ACTION', label: 'Zu erledigen', key: 'todo' },
  { status: 'IN-PROCESS', label: 'In Bearbeitung', key: 'in-process' },
  { status: 'COMPLETED', label: 'Erledigt', key: 'completed' },
  { status: 'CANCELLED', label: 'Abgebrochen', key: 'cancelled' },
];

function laneOf(task) {
  return KANBAN_LANES.some(l => l.status === task.status) ? task.status : 'NEEDS-ACTION';
}

// #518: PRIORITY 1–4 is high, 5 medium, 6–9 low; 0 or none is undefined (RFC 5545 §3.8.1.9).
// The app writes 1, 5 and 9; another client's value keeps its number while its level is unchanged.
const PRIORITY_LEVELS = {
  high: { label: 'Hoch', value: 1, cls: 'prio-high' },
  medium: { label: 'Mittel', value: 5, cls: 'prio-med' },
  low: { label: 'Niedrig', value: 9, cls: 'prio-low' },
};

export function priorityLevel(priority) {
  if (typeof priority !== 'number' || priority < 1 || priority > 9) return null;
  if (priority <= 4) return 'high';
  return priority === 5 ? 'medium' : 'low';
}

// The PRIORITY to store for the level chosen in a select, given the stored value.
function priorityFromLevel(level, stored) {
  if (!level) return null;
  return priorityLevel(stored) === level ? stored : PRIORITY_LEVELS[level].value;
}

// Only COMPLETED carries PERCENT-COMPLETE:100 and a COMPLETED date; leaving it drops both.
// The server fills in a progress for IN-PROCESS when none is left.
function statusPayload(task, status) {
  if (status === 'COMPLETED') return completionPayload(task);
  if (status === 'NEEDS-ACTION') return { ...task, status, completed: null, percentComplete: 0 };
  const pct = task.percentComplete;
  return { ...task, status, completed: null, percentComplete: pct === 100 || pct === undefined ? null : pct };
}

function isReadOnlyTask(task) {
  const cal = (store.get('calendars') || []).find(c => c.id === task.calendarId);
  return Boolean(cal && cal.readOnly);
}

export function getTaskCompletionToast(task, payload) {
  if (task && task.recurrence && payload && payload.status !== 'COMPLETED') {
    const isDate = Boolean(
      task.dueIsDate ||
      task.allDay ||
      (payload && payload.dueIsDate) ||
      (typeof payload?.due === 'string' && !payload.due.includes('T'))
    );
    const d = payload && payload.due ? new Date(payload.due) : null;
    const dateStr = d && !isNaN(d.getTime())
      ? formatDueDate(d, isDate)
      : '';
    return dateStr ? `Aufgabe auf ${dateStr} verschoben.` : 'Aufgabe verschoben.';
  }
  return 'Aufgabe als erledigt markiert.';
}

let taskCallbacks = {};
let _currentTask = null;
let _reminders = null; // #508: reminder list editor, created in setupTaskModal
let _templates = null; // #515: "Neu aus Vorlage" picker, created in setupTaskModal

export function initTaskUI(callbacks = {}) {
  taskCallbacks = callbacks;
  setupTaskModal();
}

function setupTaskModal() {
  const backdrop = document.getElementById('task-modal-backdrop');
  const closeBtn = document.getElementById('task-modal-close');
  const cancelBtn = document.getElementById('task-cancel-btn');
  const newBtn = document.getElementById('new-task-btn');
  const form = document.getElementById('task-form');

  if (newBtn) newBtn.addEventListener('click', () => openTaskModal());
  if (closeBtn) closeBtn.addEventListener('click', closeTaskModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeTaskModal);
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeTaskModal();
    });
  }

  const selectRecur = document.getElementById('task-recurrence');
  if (selectRecur) selectRecur.addEventListener('change', syncCustomRecurrenceField);

  // #508: relative task reminders count from the due date (RELATED=END, RFC 5545 §3.8.6.3).
  _reminders = createReminderEditor(document.getElementById('task-reminder-list'), document.getElementById('task-add-reminder'), {
    anchor: 'END',
    anchorName: 'Fälligkeit'
  });

  document.getElementById('task-duplicate-btn').addEventListener('click', duplicateCurrentTask);
  document.getElementById('task-template-btn').addEventListener('click', saveTaskAsTemplate);
  _templates = createTemplatePicker({
    kind: 'task',
    row: document.getElementById('task-template-row'),
    select: document.getElementById('task-template'),
    deleteBtn: document.getElementById('task-template-delete'),
    onApply: applyTaskTemplate,
  });

  document.getElementById('task-subtask-add-btn').addEventListener('click', addSubtask);
  document.getElementById('task-subtask-new').addEventListener('keydown', (e) => {
    // Enter adds the subtask instead of submitting the dialog.
    if (e.key === 'Enter') {
      e.preventDefault();
      addSubtask();
    }
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleTaskSave();
    });
  }
}

// Any rule the preset options cannot hold (INTERVAL, BYDAY, COUNT, UNTIL, …) is
// authored and shown as RRULE text in the field behind the "CUSTOM" option.
const CUSTOM_RECURRENCE = 'CUSTOM';

function syncCustomRecurrenceField() {
  const selectRecur = document.getElementById('task-recurrence');
  const group = document.getElementById('task-recurrence-custom-group');
  if (!selectRecur || !group) return;
  group.classList.toggle('hidden', selectRecur.value !== CUSTOM_RECURRENCE);
}

function setRecurrenceControls(recurrence) {
  const selectRecur = document.getElementById('task-recurrence');
  const customInput = document.getElementById('task-recurrence-custom');
  if (!selectRecur) return;
  const rule = recurrence ? String(recurrence).replace(/^RRULE:/i, '') : '';
  // A <select> refuses a value it has no option for, so reading it back tells presets apart.
  selectRecur.value = rule;
  const isPreset = selectRecur.value === rule;
  if (!isPreset) selectRecur.value = CUSTOM_RECURRENCE;
  if (customInput) customInput.value = isPreset ? '' : rule;
  syncCustomRecurrenceField();
}

export function openTaskModal(task = null) {
  _currentTask = task;
  const backdrop = document.getElementById('task-modal-backdrop');
  if (!backdrop) return;

  const titleEl = document.getElementById('task-modal-title');
  const idInput = document.getElementById('task-id');
  const hrefInput = document.getElementById('task-href');
  const etagInput = document.getElementById('task-etag');
  const inputTitle = document.getElementById('task-title');
  const inputDesc = document.getElementById('task-description');
  const selectStatus = document.getElementById('task-status');
  const selectCal = document.getElementById('task-calendar-id');
  const inputDtstart = document.getElementById('task-dtstart');
  const inputDue = document.getElementById('task-due');
  const inputDuration = document.getElementById('task-duration');
  const inputPercent = document.getElementById('task-percent-complete');
  const selectPrio = document.getElementById('task-priority');

  // Only collections whose component set holds VTODO take tasks (#495). A task stranded in another
  // one (e.g. a Google calendar, which has no tasks) shows it as its current, unselectable list,
  // so it can be moved out.
  const calendars = (store.get('calendars') || [])
    .filter(c => c.supportsVTODO === true || (task && c.id === task.calendarId));
  if (selectCal) {
    fillCalendarSelect(selectCal, calendars, (opt, c) => {
      if (c.supportsVTODO !== true) opt.textContent += ' (keine Aufgaben möglich)';
      opt.disabled = c.supportsVTODO !== true;
    });
  }
  // Says why such a task does not sync and what to do (#572); the sync worker names it too.
  const strandedHint = document.getElementById('task-stranded-hint');
  if (strandedHint) {
    const home = task ? calendars.find(c => c.id === task.calendarId) : null;
    const stranded = !!home && home.supportsVTODO !== true;
    strandedHint.textContent = !stranded ? ''
      : `${home.source === 'google' ? 'Google nimmt' : 'Dieser Kalender nimmt'} keine Aufgaben an, bitte in eine Aufgabenliste verschieben`;
    strandedHint.classList.toggle('hidden', !stranded);
  }

  if (task) {
    if (titleEl) titleEl.textContent = 'Aufgabe bearbeiten';
    if (idInput) idInput.value = task.uid || '';
    if (hrefInput) hrefInput.value = task.href || '';
    if (etagInput) etagInput.value = task.etag || '';
    if (inputTitle) inputTitle.value = task.title || '';
    if (inputDesc) inputDesc.value = task.description || '';
    if (selectStatus) selectStatus.value = task.status || 'NEEDS-ACTION';
    if (selectCal && task.calendarId) selectCal.value = task.calendarId;
    if (inputDtstart && task.dtstart) {
      const d = new Date(task.dtstart);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        if (task.dtstartIsDate) {
          inputDtstart.value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`;
        } else {
          inputDtstart.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      } else {
        inputDtstart.value = '';
      }
    } else if (inputDtstart) {
      inputDtstart.value = '';
    }
    if (inputDue && task.due) {
      const d = new Date(task.due);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        if (task.dueIsDate || task.allDay) {
          inputDue.value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`;
        } else {
          inputDue.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      } else {
        inputDue.value = '';
      }
    } else if (inputDue) {
      inputDue.value = '';
    }
    if (inputDuration) inputDuration.value = task.duration || '';
    const pct = task.percentComplete !== undefined ? task.percentComplete : task['percent-complete'];
    if (inputPercent) inputPercent.value = (pct !== null && pct !== undefined) ? String(pct) : '';
    if (selectPrio) selectPrio.value = priorityLevel(task.priority) || '';
    setRecurrenceControls(task.recurrence);
    _reminders.setAlarms(task.alarms);
    renderSubtasks();
    document.getElementById('task-duplicate-btn').classList.remove('hidden');
    _templates.hide();
  } else {
    if (titleEl) titleEl.textContent = 'Neue Aufgabe';
    if (idInput) idInput.value = '';
    if (hrefInput) hrefInput.value = '';
    if (etagInput) etagInput.value = '';
    if (inputTitle) inputTitle.value = '';
    if (inputDesc) inputDesc.value = '';
    if (selectStatus) selectStatus.value = 'NEEDS-ACTION';
    if (inputDtstart) inputDtstart.value = '';
    if (inputDue) inputDue.value = '';
    if (inputDuration) inputDuration.value = '';
    if (inputPercent) inputPercent.value = '';
    if (selectPrio) selectPrio.value = '';
    setRecurrenceControls(null);
    _reminders.setAlarms([]);
    renderSubtasks();
    document.getElementById('task-duplicate-btn').classList.add('hidden');
    _templates.show();
  }

  openDialog(backdrop, inputTitle);
}

/**
 * #515: "Duplizieren" — the dialog keeps the fields and turns into a new task, which gets its own
 * UID when it is saved; nothing is stored before "Speichern".
 */
export function openDuplicateTaskModal(task) {
  openTaskModal(task);
  duplicateCurrentTask();
}

function duplicateCurrentTask() {
  if (!_currentTask) return;
  // Kept for the date-only flags and categories handleTaskSave takes from the source; the
  // completion history belongs to the original.
  const copy = { ..._currentTask, uid: '', href: '', etag: '' };
  delete copy.completed;
  delete copy.completedHistory;
  _currentTask = copy;
  document.getElementById('task-modal-title').textContent = 'Aufgabe duplizieren';
  document.getElementById('task-id').value = '';
  document.getElementById('task-href').value = '';
  document.getElementById('task-etag').value = '';
  document.getElementById('task-duplicate-btn').classList.add('hidden');
  renderSubtasks();
  document.getElementById('task-title').focus();
}

// #515: the dialog's fields without start, due date and recurrence, for "Als Vorlage speichern".
async function saveTaskAsTemplate() {
  const title = document.getElementById('task-title').value.trim();
  if (!title) {
    notifyToast('Bitte einen Titel eingeben.', 'error');
    return;
  }
  const reminders = _reminders.collect(title);
  if (reminders.error) {
    notifyToast(reminders.error, 'error');
    return;
  }
  await _templates.save({
    title,
    calendarId: document.getElementById('task-calendar-id').value || null,
    description: document.getElementById('task-description').value.trim() || null,
    priority: priorityFromLevel(document.getElementById('task-priority').value, null),
    duration: document.getElementById('task-duration').value.trim() || null,
    alarms: templateAlarms(reminders.alarms),
  });
}

function applyTaskTemplate(fields) {
  document.getElementById('task-title').value = fields.title || '';
  const selectCal = document.getElementById('task-calendar-id');
  if (fields.calendarId && [...selectCal.options].some(o => o.value === fields.calendarId && !o.disabled)) {
    selectCal.value = fields.calendarId;
  }
  document.getElementById('task-description').value = fields.description || '';
  document.getElementById('task-priority').value = priorityLevel(fields.priority) || '';
  document.getElementById('task-duration').value = fields.duration || '';
  _reminders.setAlarms(fields.alarms || []);
}

// ── Subtasks (#518) ──────────────────────────────────────────────────────────
// A subtask is a task of its own whose RELATED-TO;RELTYPE=PARENT names the parent's UID, as Tasks.org,
// jtx Board and Thunderbird write it. The dialog of a saved task lists its subtasks as a checklist.

function subtasksOf(task) {
  return (store.get('tasks') || []).filter(t => t.parentUid === task.uid && !t.recurrenceId);
}

function renderSubtasks() {
  const group = document.getElementById('task-subtasks-group');
  const parent = _currentTask;
  const saved = Boolean(parent && parent.uid && parent.href);
  group.classList.toggle('hidden', !saved);
  if (!saved) return;
  const readOnly = isReadOnlyTask(parent);
  document.getElementById('task-subtask-add').classList.toggle('hidden', readOnly);
  const list = document.getElementById('task-subtask-list');
  const subtasks = subtasksOf(parent).sort(byTitle);
  if (subtasks.length === 0) {
    list.innerHTML = '<li class="task-subtask-empty">Keine Teilaufgaben</li>';
    return;
  }
  list.innerHTML = subtasks.map((t, i) => {
    const done = isDone(t);
    return `<li class="task-subtask-item${done ? ' is-done' : ''}" data-subtask-id="${escapeHtml(t.uid)}">
        <input type="checkbox" class="task-subtask-check" id="task-subtask-${i}" ${done ? 'checked' : ''} ${readOnly ? 'disabled' : ''} />
        <label class="task-subtask-title" for="task-subtask-${i}">${escapeHtml(t.title)}</label>
      </li>`;
  }).join('');
  list.querySelectorAll('.task-subtask-item').forEach(li => {
    const subtask = subtasks.find(t => t.uid === li.dataset.subtaskId);
    li.querySelector('.task-subtask-check').addEventListener('change', e => setSubtaskDone(subtask, e.target.checked));
  });
}

async function afterSubtaskChange() {
  if (taskCallbacks.onTaskChanged) await taskCallbacks.onTaskChanged();
  // The dialog may have been closed meanwhile.
  if (_currentTask) renderSubtasks();
}

function focusSubtask(uid) {
  const item = [...document.querySelectorAll('#task-subtask-list .task-subtask-item')].find(li => li.dataset.subtaskId === uid);
  if (item) item.querySelector('.task-subtask-check').focus();
}

async function setSubtaskDone(subtask, done) {
  const parentUid = _currentTask.uid;
  try {
    await TasksAPI.update(subtask.uid, done
      ? completionPayload(subtask)
      : { ...subtask, status: 'NEEDS-ACTION', completed: null, percentComplete: 0 });
  } catch (err) {
    notifyToast('Teilaufgabe konnte nicht gespeichert werden: ' + err.message, 'error');
  }
  // Reload either way: after a failure the checkbox shows the stored state again.
  if (_currentTask && _currentTask.uid === parentUid) {
    await afterSubtaskChange();
    focusSubtask(subtask.uid);
  }
}

async function addSubtask() {
  const input = document.getElementById('task-subtask-new');
  const title = input.value.trim();
  const parent = _currentTask;
  if (!title || !parent || !parent.uid) return;
  try {
    await TasksAPI.create({ calendarId: parent.calendarId, title, status: 'NEEDS-ACTION', parentUid: parent.uid });
  } catch (err) {
    notifyToast('Teilaufgabe konnte nicht angelegt werden: ' + err.message, 'error');
    return;
  }
  input.value = '';
  await afterSubtaskChange();
  input.focus();
}

export function closeTaskModal() {
  _currentTask = null;
  const backdrop = document.getElementById('task-modal-backdrop');
  if (backdrop) closeDialog(backdrop);
}

async function handleTaskSave() {
  const uid = document.getElementById('task-id')?.value;
  const href = document.getElementById('task-href')?.value;
  const etag = document.getElementById('task-etag')?.value;
  const title = document.getElementById('task-title')?.value.trim();
  const description = document.getElementById('task-description')?.value.trim();
  const status = document.getElementById('task-status')?.value || 'NEEDS-ACTION';
  const calendarId = document.getElementById('task-calendar-id')?.value;
  const dtstartVal = document.getElementById('task-dtstart')?.value;
  const dueVal = document.getElementById('task-due')?.value;
  const durationVal = document.getElementById('task-duration')?.value?.trim();
  const percentCompleteVal = document.getElementById('task-percent-complete')?.value;
  const priorityVal = document.getElementById('task-priority')?.value;
  const recurrenceVal = document.getElementById('task-recurrence')?.value;
  const customRecurrenceVal = document.getElementById('task-recurrence-custom')?.value.trim();

  if (!title || !calendarId) return;

  let dtstart;
  let dtstartIsDate = false;
  if (dtstartVal) {
    if (_currentTask && _currentTask.dtstartIsDate) {
      dtstartIsDate = true;
      const datePart = dtstartVal.split('T')[0];
      dtstart = `${datePart}T00:00:00.000Z`;
    } else {
      dtstart = new Date(dtstartVal).toISOString();
    }
  } else if (dtstartVal === '') {
    dtstart = null;
  } else if (_currentTask && _currentTask.dtstart !== undefined) {
    dtstart = _currentTask.dtstart;
    dtstartIsDate = !!_currentTask.dtstartIsDate;
  }

  let due = null;
  let dueIsDate = false;

  if (dueVal) {
    if (_currentTask && (_currentTask.dueIsDate || _currentTask.allDay)) {
      dueIsDate = true;
      const datePart = dueVal.split('T')[0];
      due = `${datePart}T00:00:00.000Z`;
    } else {
      due = new Date(dueVal).toISOString();
    }
  }

  let duration;
  if (durationVal) {
    duration = durationVal;
  } else if (durationVal === '') {
    duration = null;
  } else if (_currentTask && _currentTask.duration !== undefined) {
    duration = _currentTask.duration;
  }

  let percentComplete;
  if (percentCompleteVal !== undefined && percentCompleteVal !== '') {
    percentComplete = parseInt(percentCompleteVal, 10);
  } else if (percentCompleteVal === '') {
    percentComplete = null;
  } else if (_currentTask) {
    const pct = _currentTask.percentComplete !== undefined ? _currentTask.percentComplete : _currentTask['percent-complete'];
    if (pct !== undefined) percentComplete = pct;
  }

  const priority = priorityFromLevel(priorityVal, _currentTask ? _currentTask.priority : null);
  const recurrence = (recurrenceVal === CUSTOM_RECURRENCE ? customRecurrenceVal : recurrenceVal) || null;
  const reminders = _reminders.collect(title);
  if (reminders.error) {
    notifyToast(reminders.error, 'error');
    return;
  }

  const taskData = {
    calendarId,
    title,
    description: description || null,
    status,
    due,
    priority,
    recurrence,
    alarms: reminders.alarms
  };

  if (dtstart !== undefined) taskData.dtstart = dtstart;
  if (duration !== undefined) taskData.duration = duration;
  if (percentComplete !== undefined) taskData.percentComplete = percentComplete;

  if (_currentTask) {
    if (dtstartIsDate || _currentTask.dtstartIsDate) taskData.dtstartIsDate = dtstartIsDate || _currentTask.dtstartIsDate;
    if (_currentTask.dueIsDate !== undefined) taskData.dueIsDate = dueIsDate;
    if (_currentTask.completed !== undefined) taskData.completed = _currentTask.completed;
    if (_currentTask.completedHistory !== undefined) taskData.completedHistory = _currentTask.completedHistory;
    if (_currentTask.categories !== undefined) taskData.categories = _currentTask.categories;
    // A duplicated subtask stays a subtask of the same parent (#518); an edit leaves RELATED-TO alone.
    if (!uid && _currentTask.parentUid) taskData.parentUid = _currentTask.parentUid;
  } else {
    if (dtstartIsDate) taskData.dtstartIsDate = true;
    if (dueIsDate) taskData.dueIsDate = true;
  }

  try {
    if (uid && href) {
      // A different list than the stored one moves the task (#495).
      await TasksAPI.update(uid, { ...taskData, href, etag, sourceCalendarId: _currentTask.calendarId });
      notifyToast('Aufgabe gespeichert.', 'success');
    } else {
      await TasksAPI.create(taskData);
      notifyToast('Aufgabe erstellt.', 'success');
    }
    closeTaskModal();
    if (taskCallbacks.onTaskChanged) {
      await taskCallbacks.onTaskChanged();
    }
  } catch (err) {
    notifyToast('Fehler beim Speichern der Aufgabe: ' + err.message, 'error');
  }
}

export function renderKanbanBoard(container, tasks, callbacks = {}, options = {}) {
  if (!container) return;

  if (options && options.error) {
    container.innerHTML = `
      <div class="kanban-empty-state kanban-error-state" style="padding: 40px; text-align: center;">
        <div class="kanban-empty-title" style="font-size: 1.1rem; font-weight: 600; margin-bottom: 8px; color: var(--danger, #e53e3e);">Fehler beim Laden der Aufgaben</div>
        <div class="kanban-empty-subtitle" style="font-size: 0.85rem; color: var(--ink-muted, #718096);">Die Aufgaben konnten nicht geladen werden.</div>
      </div>
    `;
    return;
  }

  const searchQuery = (options && options.searchQuery !== undefined)
    ? options.searchQuery
    : (typeof store !== 'undefined' && store && store.get ? store.get('searchQuery') : '');

  let emptyNoticeHtml = '';
  if (tasks.length === 0) {
    if (searchQuery && searchQuery.trim()) {
      emptyNoticeHtml = `
        <div class="kanban-empty-state search-empty-state">
          <div class="kanban-empty-title">Keine Aufgaben gefunden</div>
          <div class="kanban-empty-subtitle">Es wurden keine Aufgaben für „${escapeHtml(searchQuery.trim())}“ gefunden.</div>
        </div>
      `;
    } else {
      emptyNoticeHtml = `
        <div class="kanban-empty-state board-empty-state">
          <div class="kanban-empty-title">Keine Aufgaben vorhanden</div>
          <div class="kanban-empty-subtitle">Klicke oben auf „Neue Aufgabe“, um die erste Aufgabe zu erstellen.</div>
        </div>
      `;
    }
  }

  const lanesHtml = KANBAN_LANES.map(l => `
      <div class="kanban-column" data-status="${l.status}">
        <div class="kanban-column-header">
          <span class="kanban-column-title">${l.label}</span>
          <span class="kanban-badge count-${l.key}">0</span>
        </div>
        <div class="kanban-cards-container" id="kanban-cards-${l.key}"></div>
      </div>`).join('');

  // `shown` is what the board currently draws: the loaded tasks plus any move not yet saved.
  let shown = tasks;
  const marks = new Map();

  const draw = () => {
    // A redraw replaces the cards; a status menu that had focus gets it back on its card's new place.
    const active = document.activeElement;
    const refocusUid = active && container.contains(active) && active.classList.contains('kanban-status-select')
      ? active.closest('.kanban-card').getAttribute('data-task-id')
      : null;

    container.innerHTML = `${emptyNoticeHtml}<div class="kanban-board">${lanesHtml}</div>`;
    const board = container.querySelector('.kanban-board');
    for (const lane of KANBAN_LANES) {
      const list = container.querySelector(`#kanban-cards-${lane.key}`);
      const laneTasks = shown.filter(t => laneOf(t) === lane.status);
      container.querySelector(`.count-${lane.key}`).textContent = laneTasks.length;
      if (laneTasks.length === 0) {
        list.innerHTML = '<div class="kanban-column-empty">Keine Aufgaben</div>';
        continue;
      }
      for (const t of laneTasks) {
        const card = createKanbanCard(t, callbacks, { board, onMove: status => moveTask(t, status) });
        const mark = marks.get(t);
        if (mark) card.classList.add(mark);
        if (mark === 'kanban-card-pending') card.setAttribute('aria-busy', 'true');
        list.appendChild(card);
      }
    }

    if (refocusUid) {
      const menu = Array.from(container.querySelectorAll('.kanban-card:not([data-recurrence-id]) .kanban-status-select'))
        .find(el => el.closest('.kanban-card').getAttribute('data-task-id') === refocusUid);
      if (menu) menu.focus();
    }
  };

  // Optimistic (#499): the card moves at once and goes back, marked, when the save fails.
  const moveTask = async (task, status) => {
    if (laneOf(task) === status || marks.get(task) === 'kanban-card-pending') return draw();
    const moved = { ...task, status };
    shown = shown.map(t => (t === task ? moved : t));
    marks.delete(task);
    marks.set(moved, 'kanban-card-pending');
    draw();

    const payload = statusPayload(task, status);
    let updated;
    try {
      updated = await TasksAPI.update(task.uid, payload);
    } catch (err) {
      shown = shown.map(t => (t === moved ? task : t));
      marks.delete(moved);
      marks.set(task, 'kanban-card-rolled-back');
      draw();
      notifyToast('Status konnte nicht gespeichert werden: ' + err.message, 'error');
      return;
    }
    marks.delete(moved);
    draw();
    notifyToast(status === 'COMPLETED' ? getTaskCompletionToast(task, updated || payload) : 'Aufgabenstatus aktualisiert.', 'success');
    if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
  };

  draw();
}

// Pointer events serve mouse, pen and touch alike. A touch only starts a drag on the grip
// (touch-action: none there); elsewhere on the card the browser keeps it for scrolling and
// cancels the pointer, which ends the gesture without a move.
const DRAG_THRESHOLD_PX = 5;

function laneAtPoint(board, x, y) {
  return Array.from(board.querySelectorAll('.kanban-column')).find(col => {
    const r = col.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) || null;
}

function enableCardDrag(card, board, onMove) {
  card.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || down.target.closest('button, select')) return;
    if (card.classList.contains('kanban-card-pending')) return;
    let dragging = false;
    let lane = null;

    const move = (e) => {
      if (e.pointerId !== down.pointerId) return;
      const dx = e.clientX - down.clientX;
      const dy = e.clientY - down.clientY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        card.classList.add('kanban-card-dragging');
      }
      e.preventDefault();
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      const over = laneAtPoint(board, e.clientX, e.clientY);
      if (over !== lane) {
        if (lane) lane.classList.remove('kanban-column-drop-target');
        if (over) over.classList.add('kanban-column-drop-target');
        lane = over;
      }
    };
    const end = (e) => {
      if (e.pointerId !== down.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (lane) lane.classList.remove('kanban-column-drop-target');
      card.classList.remove('kanban-card-dragging');
      card.style.transform = '';
      if (dragging && e.type === 'pointerup' && lane) onMove(lane.dataset.status);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

function createKanbanCard(task, callbacks, { board, onMove }) {
  const card = document.createElement('div');
  card.className = `kanban-card status-${(task.status || 'NEEDS-ACTION').toLowerCase()}`;
  card.setAttribute('data-task-id', task.uid);
  // A finished occurrence of a recurring task (#264) shares uid and href with
  // its series, so edit, reopen and delete would act on the whole series: it
  // is shown without actions.
  if (task.recurrenceId) {
    card.setAttribute('data-recurrence-id', task.recurrenceId);
    card.title = 'Erledigtes Vorkommen einer wiederkehrenden Aufgabe';
  }
  // A task in a read-only collection keeps its status: no drag, no status controls (#499).
  const movable = !task.recurrenceId && !isReadOnlyTask(task);
  if (movable) card.classList.add('kanban-card-movable');
  const statusMenu = movable ? `
      <select class="kanban-status-select" aria-label="Status von „${escapeHtml(task.title)}“">
        ${KANBAN_LANES.map(l => `<option value="${l.status}"${l.status === laneOf(task) ? ' selected' : ''}>${l.label}</option>`).join('')}
      </select>` : '';
  const statusButtons = !movable ? '' : task.status !== 'COMPLETED' ? `
        <button class="kanban-btn btn-status-next" title="Status weiterschalten" aria-label="Status weiterschalten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
        <button class="kanban-btn btn-complete" title="Als erledigt markieren" aria-label="Als erledigt markieren"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
      ` : `
        <button class="kanban-btn btn-reopen" title="Wieder öffnen" aria-label="Wieder öffnen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button>
      `;

  let dueBadge = '';
  if (task.due) {
    const d = new Date(task.due);
    const dateStr = formatDueDate(d, Boolean(task.dueIsDate || task.allDay));
    dueBadge = `<span class="kanban-due-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px;" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${dateStr}</span>`;
  }

  const level = PRIORITY_LEVELS[priorityLevel(task.priority)];
  const prioBadge = level ? `<span class="kanban-prio ${level.cls}">${level.label}</span>` : '';

  let recurBadge = '';
  if (task.recurrence) {
    const recurLabel = formatRecurrenceLabel(task.recurrence);
    recurBadge = `<span class="kanban-recurrence-badge" title="Wiederholende Aufgabe: ${escapeHtml(recurLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-right:4px;vertical-align:middle;display:inline-block;" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>${escapeHtml(recurLabel)}</span>`;
  }

  card.innerHTML = `
    ${movable ? `<span class="kanban-drag-handle" title="Ziehen, um den Status zu ändern" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>` : ''}
    <div class="kanban-card-body">
      <div class="kanban-card-title">${escapeHtml(task.title)}</div>
      ${task.description ? `<div class="kanban-card-desc">${escapeHtml(task.description)}</div>` : ''}
      <div class="kanban-card-meta">
        ${dueBadge}
        ${prioBadge}
        ${recurBadge}
      </div>
    </div>
    ${task.recurrenceId ? '' : `<div class="kanban-card-actions">
      ${statusMenu}
      ${statusButtons}
      <button class="kanban-btn btn-edit" title="Bearbeiten" aria-label="Bearbeiten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
      <button class="kanban-btn btn-delete" title="Löschen" aria-label="Löschen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg></button>
    </div>`}
  `;

  card.querySelector('.btn-edit')?.addEventListener('click', () => openTaskModal(task));

  if (movable) {
    enableCardDrag(card, board, onMove);
    card.querySelector('.kanban-status-select').addEventListener('change', (e) => onMove(e.target.value));
  }

  card.querySelector('.btn-delete')?.addEventListener('click', async () => {
    if (await confirmDialog(`Aufgabe „${task.title}“ wirklich löschen?`)) {
      try {
        const { trashId } = await TasksAPI.remove(task.uid, { calendarId: task.calendarId, href: task.href, etag: task.etag });
        showUndoToast('Aufgabe gelöscht.', trashId);
        if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
      } catch (err) {
        notifyToast('Fehler beim Löschen: ' + err.message, 'error');
      }
    }
  });

  card.querySelector('.btn-status-next')?.addEventListener('click', async () => {
    const nextStatus = task.status === 'NEEDS-ACTION' ? 'IN-PROCESS' : 'COMPLETED';
    try {
      const payload = nextStatus === 'COMPLETED' ? completionPayload(task) : { ...task, status: nextStatus };
      const updated = await TasksAPI.update(task.uid, payload);
      if (nextStatus === 'COMPLETED') {
        notifyToast(getTaskCompletionToast(task, updated || payload), 'success');
      } else {
        notifyToast('Aufgabenstatus aktualisiert.', 'success');
      }
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Aktualisieren des Status: ' + err.message, 'error');
    }
  });

  card.querySelector('.btn-complete')?.addEventListener('click', async () => {
    try {
      const payload = completionPayload(task);
      const updated = await TasksAPI.update(task.uid, payload);
      notifyToast(getTaskCompletionToast(task, updated || payload), 'success');
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Abschließen: ' + err.message, 'error');
    }
  });

  card.querySelector('.btn-reopen')?.addEventListener('click', async () => {
    try {
      await TasksAPI.update(task.uid, { ...task, status: 'NEEDS-ACTION', completed: null, percentComplete: 0 });
      notifyToast('Aufgabe wieder geöffnet.', 'info');
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Öffnen: ' + err.message, 'error');
    }
  });

  return card;
}

// ── Task area: "Liste | Kanban" (#498) ────────────────────────────────────────

const STATUS_LABELS = {
  'NEEDS-ACTION': 'Zu erledigen',
  'IN-PROCESS': 'In Bearbeitung',
  'COMPLETED': 'Erledigt',
  'CANCELLED': 'Abgebrochen',
};

function isDone(task) {
  return task.status === 'COMPLETED' || task.status === 'CANCELLED';
}

function hasPriority(task) {
  return priorityLevel(task.priority) !== null;
}

function dueTime(task) {
  return task.due ? new Date(task.due).getTime() : null;
}

const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'de', { sensitivity: 'base' });

// Missing values (no due date, no priority) sort last.
function byMissingLast(av, bv) {
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return av - bv;
}

const TASK_SORTS = {
  due: (a, b) => byMissingLast(dueTime(a), dueTime(b)) || byTitle(a, b),
  priority: (a, b) => byMissingLast(hasPriority(a) ? a.priority : null, hasPriority(b) ? b.priority : null)
    || byMissingLast(dueTime(a), dueTime(b)) || byTitle(a, b),
  title: (a, b) => byTitle(a, b) || byMissingLast(dueTime(a), dueTime(b)),
};

// How the list is sorted, grouped and filtered; kept for the page's lifetime.
const listOptions = { sort: 'due', groupByList: false, showCompleted: false, priority: 'all' };

// #518: the list's priority filter — 'all', a level, or 'none' for tasks without a priority.
function matchesPriority(task) {
  if (listOptions.priority === 'all') return true;
  return (priorityLevel(task.priority) || 'none') === listOptions.priority;
}

// The options of the latest render per task-area container, read by the switch's click handlers.
const taskAreaOptions = new WeakMap();

function calendarName(calendarId) {
  const cal = (store.get('calendars') || []).find(c => c.id === calendarId);
  return cal ? calendarLabel(cal) : calendarId;
}

/**
 * The task area: a "Liste | Kanban" switch above the chosen view.
 * options.taskView is 'list' or 'kanban'; options.onTaskViewChange(view) stores a new choice.
 */
export function renderTaskArea(container, tasks, callbacks = {}, options = {}) {
  if (!container) return;
  const taskView = options.taskView;
  if (taskView !== 'list' && taskView !== 'kanban') throw new Error(`Unknown task view "${taskView}"`);

  const focusKey = focusedKey(container);
  taskAreaOptions.set(container, options);
  // The switch is built once and kept: only the view below it is redrawn, so the kanban board
  // finds its focused status menu again (#499) and the switch keeps its focus.
  if (!container.querySelector(':scope > .task-area')) {
    container.innerHTML = `
      <div class="task-area">
        <div class="task-view-switch" role="group" aria-label="Aufgabenansicht">
          <button type="button" class="task-view-btn" data-task-view="list" data-focus-key="view-list">Liste</button>
          <button type="button" class="task-view-btn" data-task-view="kanban" data-focus-key="view-kanban">Kanban</button>
        </div>
        <div class="task-view-body"></div>
      </div>
    `;
    container.querySelectorAll('.task-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const current = taskAreaOptions.get(container);
        if (btn.dataset.taskView !== current.taskView) current.onTaskViewChange(btn.dataset.taskView);
      });
    });
  }
  container.querySelectorAll('.task-view-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.taskView === taskView));
  });

  const body = container.querySelector('.task-view-body');
  if (taskView === 'kanban') {
    renderKanbanBoard(body, tasks, callbacks, options);
  } else {
    renderTaskList(body, tasks, callbacks, options, () => renderTaskArea(container, tasks, callbacks, options));
  }
  restoreFocus(container, focusKey);
}

// Re-rendering replaces every control; the focused one is found again by its data-focus-key so a
// keyboard user keeps their place. A row that left the list (a completed task) hands the focus to
// the row now at its position.
function focusedKey(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active) || !active.dataset.focusKey) return null;
  const kind = active.dataset.focusKind;
  const index = kind ? [...container.querySelectorAll(`[data-focus-kind="${kind}"]`)].indexOf(active) : -1;
  return { key: active.dataset.focusKey, kind, index };
}

function restoreFocus(container, focus) {
  if (!focus) return;
  const exact = [...container.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === focus.key);
  if (exact) {
    exact.focus();
    return;
  }
  if (!focus.kind) return;
  const sameKind = container.querySelectorAll(`[data-focus-kind="${focus.kind}"]`);
  if (sameKind.length > 0) sameKind[Math.min(focus.index, sameKind.length - 1)].focus();
}

function renderTaskList(container, tasks, callbacks, options, rerender) {
  if (options.error) {
    container.innerHTML = `
      <div class="kanban-empty-state kanban-error-state">
        <div class="kanban-empty-title">Fehler beim Laden der Aufgaben</div>
        <div class="kanban-empty-subtitle">Die Aufgaben konnten nicht geladen werden.</div>
      </div>
    `;
    return;
  }

  const shown = tasks.filter(t => (listOptions.showCompleted || !isDone(t)) && matchesPriority(t)).sort(TASK_SORTS[listOptions.sort]);
  const groups = listOptions.groupByList
    ? [...new Set(shown.map(t => t.calendarId))]
        .map(id => ({ id, name: calendarName(id), tasks: shown.filter(t => t.calendarId === id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }))
    : [{ id: null, name: null, tasks: shown }];

  const searchQuery = (options.searchQuery || '').trim();
  let emptyText = '';
  if (shown.length === 0) {
    if (searchQuery) emptyText = `Keine Aufgaben für „${escapeHtml(searchQuery)}“ gefunden.`;
    else if (listOptions.priority !== 'all') emptyText = 'Keine Aufgaben mit dieser Priorität.';
    else if (tasks.length > 0) emptyText = 'Keine offenen Aufgaben.';
    else emptyText = 'Keine Aufgaben vorhanden. Klicke oben auf „Neue Aufgabe“, um die erste Aufgabe zu erstellen.';
  }

  container.innerHTML = `
    <div class="task-list-controls">
      <label class="task-list-control">Sortieren nach
        <select id="task-list-sort" class="form-select" data-focus-key="sort">
          <option value="due">Fälligkeit</option>
          <option value="priority">Priorität</option>
          <option value="title">Titel</option>
        </select>
      </label>
      <label class="task-list-control">Priorität
        <select id="task-list-priority" class="form-select" data-focus-key="priority">
          <option value="all">Alle</option>
          <option value="high">Hoch</option>
          <option value="medium">Mittel</option>
          <option value="low">Niedrig</option>
          <option value="none">Ohne</option>
        </select>
      </label>
      <label class="task-list-control">
        <input type="checkbox" id="task-list-group" data-focus-key="group" ${listOptions.groupByList ? 'checked' : ''} />
        Nach Liste gruppieren
      </label>
      <label class="task-list-control">
        <input type="checkbox" id="task-list-show-completed" data-focus-key="show-completed" ${listOptions.showCompleted ? 'checked' : ''} />
        Erledigte anzeigen
      </label>
    </div>
    ${emptyText ? `<div class="task-list-empty">${emptyText}</div>` : `
    <table class="task-list-table" aria-label="Aufgaben">
      <thead>
        <tr>
          <th scope="col" class="task-list-col-check"><span class="sr-only">Erledigt</span></th>
          <th scope="col">Titel</th>
          <th scope="col">Liste</th>
          <th scope="col">Fällig</th>
          <th scope="col">Priorität</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      ${groups.map(g => `
      <tbody class="task-list-group">
        ${g.name === null ? '' : `<tr class="task-list-group-header"><th scope="rowgroup" colspan="6">${escapeHtml(g.name)} <span class="task-list-group-count">(${g.tasks.length})</span></th></tr>`}
        ${g.tasks.map(taskListRow).join('')}
      </tbody>`).join('')}
    </table>`}
  `;

  const sortSelect = container.querySelector('#task-list-sort');
  sortSelect.value = listOptions.sort;
  sortSelect.addEventListener('change', () => {
    listOptions.sort = sortSelect.value;
    rerender();
  });
  const prioritySelect = container.querySelector('#task-list-priority');
  prioritySelect.value = listOptions.priority;
  prioritySelect.addEventListener('change', () => {
    listOptions.priority = prioritySelect.value;
    rerender();
  });
  container.querySelector('#task-list-group').addEventListener('change', (e) => {
    listOptions.groupByList = e.target.checked;
    rerender();
  });
  container.querySelector('#task-list-show-completed').addEventListener('change', (e) => {
    listOptions.showCompleted = e.target.checked;
    rerender();
  });

  container.querySelectorAll('.task-list-row').forEach(tr => {
    const task = shown.find(t => rowKey(t) === tr.dataset.rowKey);
    tr.querySelector('.task-list-title').addEventListener('click', () => openTaskModal(task));
    tr.querySelector('.task-list-check').addEventListener('change', (e) => {
      setTaskDone(task, e.target.checked, callbacks);
    });
  });
}

// A finished occurrence of a recurring task (#264) shares its series' uid.
function rowKey(task) {
  return `${task.calendarId}|${task.uid}|${task.recurrenceId || ''}`;
}

function taskListRow(task) {
  const key = escapeHtml(rowKey(task));
  const done = isDone(task);
  const title = escapeHtml(task.title);
  // An occurrence finished from a series cannot be reopened on its own (#264).
  const checkLabel = task.recurrenceId
    ? `„${title}“ ist ein erledigtes Vorkommen`
    : `„${title}“ ${done ? 'wieder öffnen' : 'als erledigt markieren'}`;
  const prio = hasPriority(task) ? PRIORITY_LEVELS[priorityLevel(task.priority)].label : '';
  return `
    <tr class="task-list-row${done ? ' is-done' : ''}" data-task-id="${escapeHtml(task.uid)}" data-row-key="${key}">
      <td class="task-list-col-check">
        <input type="checkbox" class="task-list-check" data-focus-key="check|${key}" data-focus-kind="check"
          aria-label="${checkLabel}" ${done ? 'checked' : ''} ${task.recurrenceId ? 'disabled' : ''} />
      </td>
      <td><button type="button" class="task-list-title" data-focus-key="title|${key}" data-focus-kind="title">${title}</button></td>
      <td class="task-list-calendar">${escapeHtml(calendarName(task.calendarId))}</td>
      <td class="task-list-due">${task.due ? formatDueDate(new Date(task.due), Boolean(task.dueIsDate || task.allDay)) : ''}</td>
      <td class="task-list-priority">${escapeHtml(prio)}</td>
      <td class="task-list-status">${STATUS_LABELS[task.status || 'NEEDS-ACTION'] || escapeHtml(task.status)}</td>
    </tr>
  `;
}

async function setTaskDone(task, done, callbacks) {
  try {
    if (done) {
      const payload = completionPayload(task);
      const updated = await TasksAPI.update(task.uid, payload);
      notifyToast(getTaskCompletionToast(task, updated || payload), 'success');
    } else {
      await TasksAPI.update(task.uid, { ...task, status: 'NEEDS-ACTION', completed: null, percentComplete: 0 });
      notifyToast('Aufgabe wieder geöffnet.', 'info');
    }
  } catch (err) {
    notifyToast('Fehler beim Aktualisieren: ' + err.message, 'error');
  }
  // Reload either way: after a failure the checkbox shows the stored state again.
  if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
}

export function renderSidebarTasks(container, countBadge, tasks, callbacks = {}, options = {}) {
  if (options && options.error) {
    if (countBadge) {
      countBadge.textContent = '!';
      countBadge.title = 'Fehler beim Laden der Aufgaben';
    }
    if (container) {
      container.innerHTML = `<div class="sidebar-tasks-error" style="font-size:0.78rem;color:var(--danger);padding:4px 8px">Fehler beim Laden der Aufgaben.</div>`;
    }
    return;
  }

  const pendingTasks = (tasks || []).filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
  if (countBadge) {
    countBadge.textContent = pendingTasks.length || '0';
    if (typeof countBadge.removeAttribute === 'function') {
      countBadge.removeAttribute('title');
    }
  }

  if (!container) return;

  if (pendingTasks.length === 0) {
    container.innerHTML = `<div class="sidebar-tasks-empty">Keine offenen Aufgaben.</div>`;
    return;
  }

  container.innerHTML = '';
  pendingTasks.slice(0, 10).forEach(task => {
    const item = document.createElement('div');
    item.className = 'sidebar-task-item';
    item.setAttribute('data-task-id', task.uid);

    const prioClass = PRIORITY_LEVELS[priorityLevel(task.priority)]?.cls || '';

    item.innerHTML = `
      <input type="checkbox" class="sidebar-task-checkbox" title="Als erledigt markieren" />
      <div class="sidebar-task-info" tabindex="0" role="button">
        <div class="sidebar-task-title ${prioClass}">${escapeHtml(task.title)}</div>
        <div class="sidebar-task-meta">
          ${task.due ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px;" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${formatDueDate(new Date(task.due), Boolean(task.dueIsDate || task.allDay))}` : ''}
          ${task.recurrence ? ` <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-left:4px;vertical-align:middle;display:inline-block;" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>` : ''}
        </div>
      </div>
    `;

    item.querySelector('.sidebar-task-checkbox').addEventListener('change', async (e) => {
      e.stopPropagation();
      try {
        const payload = completionPayload(task);
        const updated = await TasksAPI.update(task.uid, payload);
        notifyToast(getTaskCompletionToast(task, updated || payload), 'success');
        if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
      } catch (err) {
        notifyToast('Fehler beim Aktualisieren: ' + err.message, 'error');
      }
    });

    const info = item.querySelector('.sidebar-task-info');
    info.addEventListener('click', () => openTaskModal(task));
    info.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTaskModal(task);
      }
    });
    container.appendChild(item);
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
