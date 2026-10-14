/**
 * tasks.js — VTODO Tasks & Kanban Board rendering engine.
 */

import { store } from './store.js';
import { TasksAPI } from './api.js';
import { openDialog, closeDialog, confirmDialog } from './dialogFocus.js';
import { showToast } from './app.js';

function notifyToast(message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
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
      ? (isDate ? d.toLocaleDateString('de-DE', { timeZone: 'UTC' }) : d.toLocaleDateString('de-DE'))
      : '';
    return dateStr ? `Aufgabe auf ${dateStr} verschoben.` : 'Aufgabe verschoben.';
  }
  return 'Aufgabe als erledigt markiert.';
}

let taskCallbacks = {};
let _currentTask = null;

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

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleTaskSave();
    });
  }
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
  const selectRecur = document.getElementById('task-recurrence');

  // Populate calendar options
  const calendars = store.get('calendars') || [];
  if (selectCal) {
    selectCal.innerHTML = '';
    calendars.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      selectCal.appendChild(opt);
    });
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
    if (selectPrio) selectPrio.value = task.priority !== null && task.priority !== undefined ? String(task.priority) : '';
    if (selectRecur) selectRecur.value = task.recurrence || '';
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
    if (selectRecur) selectRecur.value = '';
  }

  openDialog(backdrop, inputTitle);
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

  const priority = priorityVal !== '' ? parseInt(priorityVal, 10) : null;
  const recurrence = recurrenceVal || null;

  const taskData = {
    calendarId,
    title,
    description: description || null,
    status,
    due,
    priority,
    recurrence
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
  } else {
    if (dtstartIsDate) taskData.dtstartIsDate = true;
    if (dueIsDate) taskData.dueIsDate = true;
  }

  try {
    if (uid && href) {
      await TasksAPI.update(uid, { ...taskData, href, etag });
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

  container.innerHTML = `
    ${emptyNoticeHtml}
    <div class="kanban-board">
      <div class="kanban-column" data-status="NEEDS-ACTION">
        <div class="kanban-column-header">
          <span class="kanban-column-title">Zu erledigen</span>
          <span class="kanban-badge count-todo">0</span>
        </div>
        <div class="kanban-cards-container" id="kanban-cards-todo"></div>
      </div>
      <div class="kanban-column" data-status="IN-PROCESS">
        <div class="kanban-column-header">
          <span class="kanban-column-title">In Bearbeitung</span>
          <span class="kanban-badge count-in-process">0</span>
        </div>
        <div class="kanban-cards-container" id="kanban-cards-in-process"></div>
      </div>
      <div class="kanban-column" data-status="COMPLETED">
        <div class="kanban-column-header">
          <span class="kanban-column-title">Erledigt</span>
          <span class="kanban-badge count-completed">0</span>
        </div>
        <div class="kanban-cards-container" id="kanban-cards-completed"></div>
      </div>
    </div>
  `;

  const todoList = container.querySelector('#kanban-cards-todo');
  const inProcessList = container.querySelector('#kanban-cards-in-process');
  const completedList = container.querySelector('#kanban-cards-completed');

  const todoTasks = tasks.filter(t => (t.status || 'NEEDS-ACTION') === 'NEEDS-ACTION');
  const inProcessTasks = tasks.filter(t => t.status === 'IN-PROCESS');
  const completedTasks = tasks.filter(t => t.status === 'COMPLETED' || t.status === 'CANCELLED');

  container.querySelector('.count-todo').textContent = todoTasks.length;
  container.querySelector('.count-in-process').textContent = inProcessTasks.length;
  container.querySelector('.count-completed').textContent = completedTasks.length;

  if (todoTasks.length > 0) {
    todoTasks.forEach(t => todoList.appendChild(createKanbanCard(t, callbacks)));
  } else {
    todoList.innerHTML = '<div class="kanban-column-empty">Keine Aufgaben</div>';
  }

  if (inProcessTasks.length > 0) {
    inProcessTasks.forEach(t => inProcessList.appendChild(createKanbanCard(t, callbacks)));
  } else {
    inProcessList.innerHTML = '<div class="kanban-column-empty">Keine Aufgaben</div>';
  }

  if (completedTasks.length > 0) {
    completedTasks.forEach(t => completedList.appendChild(createKanbanCard(t, callbacks)));
  } else {
    completedList.innerHTML = '<div class="kanban-column-empty">Keine Aufgaben</div>';
  }
}

function createKanbanCard(task, callbacks) {
  const card = document.createElement('div');
  card.className = `kanban-card status-${(task.status || 'NEEDS-ACTION').toLowerCase()}`;
  card.setAttribute('data-task-id', task.uid);

  let dueBadge = '';
  if (task.due) {
    const d = new Date(task.due);
    const dateStr = (task.dueIsDate || task.allDay)
      ? d.toLocaleDateString('de-DE', { timeZone: 'UTC' })
      : d.toLocaleDateString('de-DE');
    dueBadge = `<span class="kanban-due-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${dateStr}</span>`;
  }

  let prioBadge = '';
  if (task.priority === 1) prioBadge = `<span class="kanban-prio prio-high">Hoch</span>`;
  else if (task.priority === 2) prioBadge = `<span class="kanban-prio prio-med">Mittel</span>`;
  else if (task.priority === 3) prioBadge = `<span class="kanban-prio prio-low">Niedrig</span>`;

  let recurBadge = '';
  if (task.recurrence) {
    const recurLabel = formatRecurrenceLabel(task.recurrence);
    recurBadge = `<span class="kanban-recurrence-badge" title="Wiederholende Aufgabe: ${escapeHtml(recurLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-right:4px;vertical-align:middle;display:inline-block;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>${escapeHtml(recurLabel)}</span>`;
  }

  card.innerHTML = `
    <div class="kanban-card-body">
      <div class="kanban-card-title">${escapeHtml(task.title)}</div>
      ${task.description ? `<div class="kanban-card-desc">${escapeHtml(task.description)}</div>` : ''}
      <div class="kanban-card-meta">
        ${dueBadge}
        ${prioBadge}
        ${recurBadge}
      </div>
    </div>
    <div class="kanban-card-actions">
      ${task.status !== 'COMPLETED' ? `
        <button class="kanban-btn btn-status-next" title="Status weiterschalten" aria-label="Status weiterschalten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
        <button class="kanban-btn btn-complete" title="Als erledigt markieren" aria-label="Als erledigt markieren"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"></polyline></svg></button>
      ` : `
        <button class="kanban-btn btn-reopen" title="Wieder öffnen" aria-label="Wieder öffnen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button>
      `}
      <button class="kanban-btn btn-edit" title="Bearbeiten" aria-label="Bearbeiten"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
      <button class="kanban-btn btn-delete" title="Löschen" aria-label="Löschen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg></button>
    </div>
  `;

  card.querySelector('.btn-edit')?.addEventListener('click', () => openTaskModal(task));

  card.querySelector('.btn-delete')?.addEventListener('click', async () => {
    if (await confirmDialog('Möchtest du diese Aufgabe wirklich löschen?')) {
      try {
        await TasksAPI.remove(task.uid, { calendarId: task.calendarId, href: task.href, etag: task.etag });
        notifyToast('Aufgabe gelöscht.', 'info');
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
    container.innerHTML = `<div class="sidebar-tasks-empty" style="font-size:0.78rem;color:var(--ink-muted);padding:4px 8px">Keine offenen Aufgaben.</div>`;
    return;
  }

  container.innerHTML = '';
  pendingTasks.slice(0, 10).forEach(task => {
    const item = document.createElement('div');
    item.className = 'sidebar-task-item';
    item.setAttribute('data-task-id', task.uid);

    let prioClass = '';
    if (task.priority === 1) prioClass = 'prio-high';
    else if (task.priority === 2) prioClass = 'prio-med';
    else if (task.priority === 3) prioClass = 'prio-low';

    item.innerHTML = `
      <input type="checkbox" class="sidebar-task-checkbox" title="Als erledigt markieren" />
      <div class="sidebar-task-info" style="cursor:pointer; flex:1;">
        <div class="sidebar-task-title ${prioClass}">${escapeHtml(task.title)}</div>
        <div class="sidebar-task-meta" style="font-size:0.75rem; color:var(--ink-muted);">
          ${task.due ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:4px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${(task.dueIsDate || task.allDay) ? new Date(task.due).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : new Date(task.due).toLocaleDateString('de-DE')}` : ''}
          ${task.recurrence ? ` <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="margin-left:4px;vertical-align:middle;display:inline-block;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>` : ''}
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

    item.querySelector('.sidebar-task-info').addEventListener('click', () => openTaskModal(task));
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
