/**
 * templates.js — "Als Vorlage speichern" and "Neu aus Vorlage" for the event and task dialogs (#515).
 * A template holds the fields without date and time; it lives in the app database, per user.
 */

import { TemplatesAPI } from './api.js';
import { showToast } from './app.js';
import { confirmDialog } from './dialogFocus.js';

// A reminder at a fixed time is a date, which a template does not keep; relative ones stay.
export function templateAlarms(alarms) {
  return alarms
    .filter(a => /^[+-]?P/.test(String(a.trigger || '')))
    .map(a => ({
      action: a.action || 'DISPLAY',
      trigger: a.trigger,
      description: a.description || '',
      ...(a.related ? { related: a.related } : {}),
    }));
}

/**
 * The "Neu aus Vorlage" picker of one dialog. `onApply(fields)` fills the form from a template.
 * show() loads the user's templates and shows the picker when there are any; hide() is for edit mode.
 */
export function createTemplatePicker({ kind, row, select, deleteBtn, onApply }) {
  let templates = [];
  let generation = 0;

  function render() {
    select.innerHTML = '';
    select.append(new Option('Keine Vorlage', ''));
    for (const t of templates) select.append(new Option(t.name, t.id));
    deleteBtn.disabled = true;
    row.classList.toggle('hidden', templates.length === 0);
  }

  const selected = () => templates.find(t => t.id === select.value);

  select.addEventListener('change', () => {
    const t = selected();
    deleteBtn.disabled = !t;
    if (t) onApply(t.fields);
  });

  deleteBtn.addEventListener('click', async () => {
    const t = selected();
    if (!t || !(await confirmDialog(`Vorlage „${t.name}“ löschen?`))) return;
    try {
      await TemplatesAPI.remove(t.id);
    } catch (err) {
      showToast(`Die Vorlage wurde nicht gelöscht. ${err.message}`, 'error');
      return;
    }
    templates = templates.filter(x => x.id !== t.id);
    render();
    showToast(`Vorlage „${t.name}“ gelöscht.`, 'info');
  });

  return {
    async show() {
      const g = ++generation;
      row.classList.add('hidden');
      let loaded;
      try {
        loaded = (await TemplatesAPI.list(kind)).templates;
      } catch (err) {
        showToast(`Vorlagen konnten nicht geladen werden. ${err.message}`, 'error');
        return;
      }
      if (g !== generation) return; // the dialog was reopened or switched to editing meanwhile
      templates = loaded;
      render();
    },
    hide() {
      generation++;
      row.classList.add('hidden');
    },
    async save(fields) {
      const name = fields.title;
      try {
        templates.push(await TemplatesAPI.create(kind, name, fields));
      } catch (err) {
        showToast(`Die Vorlage wurde nicht gespeichert. ${err.message}`, 'error');
        return;
      }
      showToast(`Vorlage „${name}“ gespeichert.`, 'success');
    },
  };
}
