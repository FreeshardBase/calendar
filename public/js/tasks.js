/**
 * tasks.js — VTODO Tasks & Kanban Board rendering engine.
 */

import { store } from './store.js';
import { TasksAPI } from './api.js';
import { openDialog, closeDialog } from './dialogFocus.js';
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

let taskCallbacks = {};

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
  const inputDue = document.getElementById('task-due');
  const selectPrio = document.getElementById('task-priority');
  const selectRecur = document.getElementById('task-recurrence');

  // Populate calendar options
  const calendars = store.get('calendars') || [];
  if (selectCal) {
    selectCal.innerHTML = calendars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
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
    if (inputDue && task.due) {
      inputDue.value = new Date(task.due).toISOString().slice(0, 16);
    } else if (inputDue) {
      inputDue.value = '';
    }
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
    if (inputDue) inputDue.value = '';
    if (selectPrio) selectPrio.value = '';
    if (selectRecur) selectRecur.value = '';
  }

  openDialog(backdrop, inputTitle);
}

export function closeTaskModal() {
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
  const dueVal = document.getElementById('task-due')?.value;
  const priorityVal = document.getElementById('task-priority')?.value;
  const recurrenceVal = document.getElementById('task-recurrence')?.value;

  if (!title || !calendarId) return;

  const due = dueVal ? new Date(dueVal).toISOString() : null;
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

export function renderKanbanBoard(container, tasks, callbacks = {}) {
  container.innerHTML = `
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

  todoTasks.forEach(t => todoList.appendChild(createKanbanCard(t, callbacks)));
  inProcessTasks.forEach(t => inProcessList.appendChild(createKanbanCard(t, callbacks)));
  completedTasks.forEach(t => completedList.appendChild(createKanbanCard(t, callbacks)));
}

function createKanbanCard(task, callbacks) {
  const card = document.createElement('div');
  card.className = `kanban-card status-${(task.status || 'NEEDS-ACTION').toLowerCase()}`;
  card.setAttribute('data-task-id', task.uid);

  let dueBadge = '';
  if (task.due) {
    const d = new Date(task.due);
    dueBadge = `<span class="kanban-due-date">📅 ${d.toLocaleDateString('de-DE')}</span>`;
  }

  let prioBadge = '';
  if (task.priority === 1) prioBadge = `<span class="kanban-prio prio-high">Hoch</span>`;
  else if (task.priority === 2) prioBadge = `<span class="kanban-prio prio-med">Mittel</span>`;
  else if (task.priority === 3) prioBadge = `<span class="kanban-prio prio-low">Niedrig</span>`;

  let recurBadge = '';
  if (task.recurrence) {
    const recurLabel = formatRecurrenceLabel(task.recurrence);
    recurBadge = `<span class="kanban-recurrence-badge" title="Wiederholende Aufgabe: ${escapeHtml(recurLabel)}">🔄 ${escapeHtml(recurLabel)}</span>`;
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
        <button class="kanban-btn btn-status-next" title="Status weiterschalten">➡️</button>
        <button class="kanban-btn btn-complete" title="Als erledigt markieren">✓</button>
      ` : `
        <button class="kanban-btn btn-reopen" title="Wieder öffnen">↩️</button>
      `}
      <button class="kanban-btn btn-edit" title="Bearbeiten">✏️</button>
      <button class="kanban-btn btn-delete" title="Löschen">🗑️</button>
    </div>
  `;

  card.querySelector('.btn-edit')?.addEventListener('click', () => openTaskModal(task));

  card.querySelector('.btn-delete')?.addEventListener('click', async () => {
    if (confirm('Möchtest du diese Aufgabe wirklich löschen?')) {
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
      const payload = (nextStatus === 'COMPLETED' && task.recurrence) ? advanceRecurringTaskJS(task) : { ...task, status: nextStatus };
      await TasksAPI.update(task.uid, payload);
      notifyToast(nextStatus === 'COMPLETED' ? 'Aufgabe als erledigt markiert.' : 'Aufgabenstatus aktualisiert.', 'success');
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Aktualisieren des Status: ' + err.message, 'error');
    }
  });

  card.querySelector('.btn-complete')?.addEventListener('click', async () => {
    try {
      const payload = task.recurrence ? advanceRecurringTaskJS(task) : { ...task, status: 'COMPLETED' };
      await TasksAPI.update(task.uid, payload);
      notifyToast('Aufgabe als erledigt markiert.', 'success');
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Abschließen: ' + err.message, 'error');
    }
  });

  card.querySelector('.btn-reopen')?.addEventListener('click', async () => {
    try {
      await TasksAPI.update(task.uid, { ...task, status: 'NEEDS-ACTION' });
      notifyToast('Aufgabe wieder geöffnet.', 'info');
      if (callbacks.onTaskChanged) await callbacks.onTaskChanged();
    } catch (err) {
      notifyToast('Fehler beim Öffnen: ' + err.message, 'error');
    }
  });

  return card;
}

export function advanceRecurringTaskJS(task) {
  if (!task || !task.recurrence) return { ...task, status: 'COMPLETED', completed: new Date().toISOString(), percentComplete: 100 };

  if (typeof window !== 'undefined' && window.ICAL && window.ICAL.Recur) {
    const rruleStr = String(task.recurrence).replace(/^RRULE:/i, '');
    let recur;
    try {
      recur = window.ICAL.Recur.fromString(rruleStr);
    } catch (_) {
      recur = null;
    }
    const baseDue = task.due ? new Date(task.due) : new Date();
    if (!isNaN(baseDue.getTime()) && recur) {
      const dtStartMs = task.dtstart ? new Date(task.dtstart).getTime() : baseDue.getTime();
      const dtStart = isNaN(dtStartMs) ? baseDue : new Date(dtStartMs);
      const icalStart = window.ICAL.Time.fromJSDate(dtStart, true);
      const iterator = recur.iterator(icalStart);
      const dueMs = baseDue.getTime();
      let steps = 0;
      let next;
      while (steps < 50000) {
        next = iterator.next();
        steps++;
        if (!next) {
          return { ...task, status: 'COMPLETED', completed: new Date().toISOString(), percentComplete: 100 };
        }
        const nextMs = next.toJSDate().getTime();
        if (nextMs > dueMs) {
          return {
            ...task,
            due: next.toJSDate().toISOString(),
            status: 'NEEDS-ACTION',
            completed: null,
            percentComplete: 0
          };
        }
      }
      return { ...task, status: 'COMPLETED', completed: new Date().toISOString(), percentComplete: 100 };
    }
  }

  const rruleStr = String(task.recurrence).replace(/^RRULE:/i, '');
  const rruleUpper = rruleStr.toUpperCase();
  const baseDue = task.due ? new Date(task.due) : new Date();
  if (isNaN(baseDue.getTime())) return { ...task, status: 'COMPLETED', completed: new Date().toISOString(), percentComplete: 100 };

  const untilMatch = rruleUpper.match(/UNTIL=([0-9TJSZ]+)/);
  if (untilMatch) {
    const uStr = untilMatch[1];
    let untilDate;
    if (uStr.length === 8) {
      untilDate = new Date(Date.UTC(parseInt(uStr.slice(0,4),10), parseInt(uStr.slice(4,6),10)-1, parseInt(uStr.slice(6,8),10), 23, 59, 59));
    } else {
      untilDate = new Date(uStr.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, '$1-$2-$3T$4:$5:$6Z'));
    }
    if (!isNaN(untilDate.getTime()) && baseDue.getTime() >= untilDate.getTime()) {
      return { ...task, status: 'COMPLETED', completed: new Date().toISOString(), percentComplete: 100 };
    }
  }

  let interval = 1;
  const matchInterval = rruleUpper.match(/INTERVAL=(\d+)/);
  if (matchInterval) {
    interval = parseInt(matchInterval[1], 10) || 1;
  }

  const nextDate = new Date(baseDue.getTime());
  if (rruleUpper.includes('FREQ=DAILY')) {
    nextDate.setUTCDate(nextDate.getUTCDate() + interval);
  } else if (rruleUpper.includes('FREQ=WEEKLY')) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 7 * interval);
  } else if (rruleUpper.includes('FREQ=MONTHLY')) {
    nextDate.setUTCMonth(nextDate.getUTCMonth() + interval);
  } else if (rruleUpper.includes('FREQ=YEARLY')) {
    nextDate.setUTCFullYear(nextDate.getUTCFullYear() + interval);
  } else {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  }

  return {
    ...task,
    due: nextDate.toISOString(),
    status: 'NEEDS-ACTION',
    completed: null,
    percentComplete: 0
  };
}

export function renderSidebarTasks(container, countBadge, tasks, callbacks = {}) {
  if (!container) return;
  const pendingTasks = (tasks || []).filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
  if (countBadge) countBadge.textContent = pendingTasks.length;

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
          ${task.due ? `📅 ${new Date(task.due).toLocaleDateString('de-DE')}` : ''}
          ${task.recurrence ? ` 🔄` : ''}
        </div>
      </div>
    `;

    item.querySelector('.sidebar-task-checkbox').addEventListener('change', async (e) => {
      e.stopPropagation();
      try {
        const payload = task.recurrence ? advanceRecurringTaskJS(task) : { ...task, status: 'COMPLETED' };
        await TasksAPI.update(task.uid, payload);
        notifyToast('Aufgabe als erledigt markiert.', 'success');
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
    .replace(/"/g, '&quot;');
}
