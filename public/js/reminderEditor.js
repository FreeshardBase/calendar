/**
 * reminderEditor.js — list of reminders (one VALARM each) for the event and task dialogs (#508).
 *
 * A DISPLAY reminder relative to the dialog's anchor (event start, task due date) or at an
 * absolute time can be edited. Any other VALARM (AUDIO, EMAIL, a compound duration, the other
 * anchor) is shown read-only and saved back as it was loaded; every row can be removed.
 */

import { formatDate } from './locale.js';
import { t } from './i18n.js';

const UNITS = [
  ['M', 'views.reminderEditor.unitMinutes'],
  ['H', 'views.reminderEditor.unitHours'],
  ['D', 'views.reminderEditor.unitDays'],
  ['W', 'views.reminderEditor.unitWeeks']
];
const ACTION_SUFFIX = { AUDIO: 'views.reminderEditor.actionAudio', EMAIL: 'views.reminderEditor.actionEmail' };
// The words of the direction select for each anchor (event start, task due date).
const ANCHOR_DIRECTIONS = {
  START: ['views.reminderEditor.beforeAnchorStart', 'views.reminderEditor.afterAnchorStart'],
  END: ['views.reminderEditor.beforeAnchorEnd', 'views.reminderEditor.afterAnchorEnd']
};
const DURATION_RE = /^([+-])?P(?:(\d+)([WD])|T(\d+)([HMS]))$/;
const ABSOLUTE_RE = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?Z$/;
// The parts of a relative trigger, largest unit first, with their plural messages.
const DURATION_PARTS = [
  [2, 'views.reminderEditor.weeks'],
  [3, 'views.reminderEditor.days'],
  [4, 'views.reminderEditor.hours'],
  [5, 'views.reminderEditor.minutes'],
  [6, 'views.reminderEditor.seconds']
];

export function formatAlarmTriggerLabel(trigger, related = null) {
  if (!trigger) return t('views.reminderEditor.none');
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }

  const abs = str.match(ABSOLUTE_RE);
  if (abs) {
    const [, y, mo, d, h, mi, sec] = abs;
    const when = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
    return t('views.reminderEditor.at', { when: formatDate(when, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) });
  }

  const toEnd = String(related || '').toUpperCase() === 'END';
  const atAnchor = t(toEnd ? 'views.reminderEditor.atEnd' : 'views.reminderEditor.atStart');
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return atAnchor;

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return t('views.reminderEditor.unknown', { trigger: str });

  const parts = DURATION_PARTS
    .map(([group, key]) => [parseInt(match[group] || '0', 10), key])
    .filter(([count]) => count > 0)
    .map(([count, key]) => t(key, { count }));
  if (parts.length === 0) return atAnchor;

  const before = match[1] === '-';
  const key = toEnd
    ? (before ? 'views.reminderEditor.beforeEnd' : 'views.reminderEditor.afterEnd')
    : (before ? 'views.reminderEditor.before' : 'views.reminderEditor.after');
  return t(key, { amount: parts.join(' ') });
}

const pad = n => String(n).padStart(2, '0');

function localInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The editable form of an alarm, or null when the dialog cannot edit it without losing something.
function editableState(alarm, anchor) {
  if (String(alarm.action || 'DISPLAY').toUpperCase() !== 'DISPLAY') return null;
  const trigger = String(alarm.trigger || '').trim();
  const abs = trigger.match(ABSOLUTE_RE);
  if (abs) {
    const [, y, mo, d, h, mi, s] = abs;
    return { kind: 'absolute', at: localInputValue(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))) };
  }
  if (String(alarm.related || 'START').toUpperCase() !== anchor) return null;
  const dur = trigger.match(DURATION_RE);
  if (!dur) return null;
  const amount = dur[2] !== undefined ? dur[2] : dur[4];
  const unit = dur[3] || dur[5];
  if (unit === 'S') return amount === '0' ? { kind: 'relative', amount: '0', unit: 'M', direction: '-' } : null;
  return { kind: 'relative', amount: String(Number(amount)), unit, direction: dur[1] === '-' ? '-' : '+' };
}

function sameState(a, b) {
  return Boolean(a && b) && a.kind === b.kind && (a.kind === 'absolute'
    ? a.at === b.at
    : Number(a.amount) === Number(b.amount) && (Number(a.amount) === 0 || (a.unit === b.unit && a.direction === b.direction)));
}

function option(value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
}

/**
 * @param {HTMLElement} list    <ul> holding the rows
 * @param {HTMLElement} addBtn  button that appends a reminder
 * @param {object} opts         anchor: 'START' (event start) | 'END' (task due date), which also
 *                              names the direction ("vor Beginn" / "vor Fälligkeit");
 *                              onAdd: called after a reminder was added
 */
export function createReminderEditor(list, addBtn, { anchor, onAdd = null }) {
  if (!Object.hasOwn(ANCHOR_DIRECTIONS, anchor)) throw new Error(`Unknown reminder anchor: ${anchor}`);
  let rows = [];

  function render() {
    list.replaceChildren(...rows.map(renderRow));
  }

  // The rows hold their state outside the DOM, so a new language just redraws them.
  window.addEventListener('ui-language-changed', render);

  function renderRow(row, index) {
    const li = document.createElement('li');
    li.className = 'reminder-row';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn reminder-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('views.reminderEditor.remove'));
    remove.addEventListener('click', () => {
      rows.splice(index, 1);
      render();
      (rows[index] ? list.children[index].querySelector('select, input, .reminder-remove') : addBtn).focus();
    });

    if (!row.state) {
      const label = document.createElement('span');
      label.className = 'reminder-fixed';
      const action = String(row.original.action || 'DISPLAY').toUpperCase();
      const text = formatAlarmTriggerLabel(row.original.trigger, row.original.related);
      label.textContent = Object.hasOwn(ACTION_SUFFIX, action) ? t(ACTION_SUFFIX[action], { label: text }) : text;
      label.title = t('views.reminderEditor.foreign');
      li.append(label, remove);
      return li;
    }

    const state = row.state;
    const kind = document.createElement('select');
    kind.className = 'form-select inline-select reminder-kind';
    kind.setAttribute('aria-label', t('views.reminderEditor.kind'));
    kind.append(option('relative', t('views.reminderEditor.kindRelative')), option('absolute', t('views.reminderEditor.kindAbsolute')));
    kind.value = state.kind;

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '1';
    amount.className = 'form-input inline-input reminder-amount';
    amount.setAttribute('aria-label', t('views.reminderEditor.amount'));
    amount.value = state.amount ?? '15';

    const unit = document.createElement('select');
    unit.className = 'form-select inline-select reminder-unit';
    unit.setAttribute('aria-label', t('views.reminderEditor.unit'));
    unit.append(...UNITS.map(([v, key]) => option(v, t(key))));
    unit.value = state.unit ?? 'M';

    const direction = document.createElement('select');
    direction.className = 'form-select inline-select reminder-direction';
    direction.setAttribute('aria-label', t('views.reminderEditor.direction'));
    const [beforeKey, afterKey] = ANCHOR_DIRECTIONS[anchor];
    direction.append(option('-', t(beforeKey)), option('+', t(afterKey)));
    direction.value = state.direction ?? '-';

    const at = document.createElement('input');
    at.type = 'datetime-local';
    at.className = 'form-input inline-input reminder-at';
    at.setAttribute('aria-label', t('views.reminderEditor.atLabel'));
    at.value = state.at ?? '';

    const sync = () => {
      const relative = kind.value === 'relative';
      for (const el of [amount, unit, direction]) el.hidden = !relative;
      at.hidden = relative;
    };
    kind.addEventListener('change', () => { state.kind = kind.value; sync(); });
    amount.addEventListener('input', () => { state.amount = amount.value; });
    unit.addEventListener('change', () => { state.unit = unit.value; });
    direction.addEventListener('change', () => { state.direction = direction.value; });
    at.addEventListener('input', () => { state.at = at.value; });
    sync();

    li.append(kind, amount, unit, direction, at, remove);
    return li;
  }

  addBtn.addEventListener('click', () => {
    rows.push({ original: null, loaded: null, state: { kind: 'relative', amount: '15', unit: 'M', direction: '-' } });
    render();
    list.lastElementChild.querySelector('.reminder-amount').focus();
    if (onAdd) onAdd();
  });

  return {
    // #625: a new item starts with the user's default reminder, `minutes` before the anchor.
    setNewReminder(minutes) {
      rows = [{ original: null, loaded: null, state: { kind: 'relative', amount: String(minutes), unit: 'M', direction: '-' } }];
      render();
    },

    setAlarms(alarms) {
      rows = (Array.isArray(alarms) ? alarms : []).map(original => {
        const state = editableState(original, anchor);
        return { original, loaded: state && { ...state }, state };
      });
      render();
    },

    /**
     * The reminders as alarms for the API, or { error } naming the first incomplete row.
     * An unchanged row returns its loaded alarm, so the server keeps that VALARM as stored.
     */
    collect(description) {
      const alarms = [];
      for (const row of rows) {
        if (!row.state || sameState(row.state, row.loaded)) {
          alarms.push(row.original);
          continue;
        }
        const s = row.state;
        let trigger;
        let related = null;
        if (s.kind === 'absolute') {
          const when = new Date(s.at);
          if (!s.at || isNaN(when.getTime())) return { error: t('views.reminderEditor.errorAt') };
          trigger = when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        } else {
          if (!/^\d+$/.test(String(s.amount))) return { error: t('views.reminderEditor.errorAmount') };
          const n = Number(s.amount);
          trigger = n === 0 ? 'PT0S' : `${s.direction === '-' ? '-' : ''}P${s.unit === 'H' || s.unit === 'M' ? 'T' : ''}${n}${s.unit}`;
          if (anchor === 'END') related = 'END';
        }
        const alarm = { action: 'DISPLAY', trigger, description };
        if (related) alarm.related = related;
        alarms.push(alarm);
      }
      return { alarms };
    }
  };
}
