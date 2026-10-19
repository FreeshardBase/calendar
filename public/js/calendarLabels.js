/**
 * calendarLabels.js — How calendars are named and grouped in pickers and the sidebar (#496).
 *
 * A calendar mirrored from a linked account carries `linkedAccountId`. It is listed under the
 * account's current name, looked up in the store on every render, so renaming the account
 * relabels everything without a reload.
 */
import { store } from './store.js';

// The user's custom name for a linked account; the provider user name only when none is set.
export function accountLabel(account) {
  return account.displayName || account.username;
}

function linkedAccount(cal) {
  if (!cal.linkedAccountId) return null;
  const account = store.get('accounts').find(a => a.id === cal.linkedAccountId);
  if (account) return account;
  // #613: a Microsoft 365 account is not in the account list; the calendar names it.
  return cal.linkedAccountName ? { id: cal.linkedAccountId, username: cal.linkedAccountName, displayName: null } : null;
}

// A provider names an account's primary calendar after its user name (Google: the e-mail
// address). That calendar is listed under the account's name instead.
export function calendarLabel(cal) {
  const account = linkedAccount(cal);
  return account && cal.name === account.username ? accountLabel(account) : cal.name;
}

// #500: a collection holds events (Kalender), tasks (Aufgabenliste) or, when mixed, both. Calendar
// views list the ones with VEVENT, task views the ones with VTODO.
export function holdsEvents(cal) {
  return cal.supportsVEVENT === true;
}

export function holdsTasks(cal) {
  return cal.supportsVTODO === true;
}

// What the UI calls the collection: a task-only collection is an Aufgabenliste.
export function collectionNoun(cal) {
  return holdsTasks(cal) && !holdsEvents(cal) ? 'Aufgabenliste' : 'Kalender';
}

// The type as the settings list names it; a mixed collection says so.
export function collectionTypeLabel(cal) {
  return holdsTasks(cal) && holdsEvents(cal) ? 'Gemischt' : collectionNoun(cal);
}

// [{ label, calendars }] in first-seen order: the shard's own calendars (label null), then one
// group per linked account.
export function groupCalendarsByAccount(cals) {
  const groups = new Map();
  for (const cal of cals) {
    const account = linkedAccount(cal);
    const key = account ? account.id : null;
    if (!groups.has(key)) groups.set(key, { label: account ? accountLabel(account) : null, calendars: [] });
    groups.get(key).calendars.push(cal);
  }
  const own = groups.get(null);
  return own ? [own, ...[...groups.values()].filter(g => g !== own)] : [...groups.values()];
}

// Fills a <select> with one option per calendar; a linked account's calendars go into an
// <optgroup> labelled with the account's name. `decorate(option, cal)` may adjust each option.
export function fillCalendarSelect(select, cals, decorate = () => {}) {
  select.innerHTML = '';
  for (const group of groupCalendarsByAccount(cals)) {
    let parent = select;
    if (group.label !== null) {
      parent = document.createElement('optgroup');
      parent.label = group.label;
      select.appendChild(parent);
    }
    for (const cal of group.calendars) {
      const opt = document.createElement('option');
      opt.value = cal.id;
      opt.textContent = calendarLabel(cal);
      decorate(opt, cal);
      parent.appendChild(opt);
    }
  }
}
