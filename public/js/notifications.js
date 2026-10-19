/**
 * notifications.js — Browser Push & Desktop Notification Manager for VALARM Triggers.
 */

import { store } from './store.js';
import { showToast } from './app.js';

const NOTIFIED_STORAGE_KEY = 'webcalendar_notified_alarms';

function loadNotifiedAlarms() {
  const set = new Set();
  if (typeof localStorage !== 'undefined') {
    try {
      const data = localStorage.getItem(NOTIFIED_STORAGE_KEY);
      if (data) {
        const arr = JSON.parse(data);
        if (Array.isArray(arr)) {
          arr.forEach(k => set.add(k));
        }
      }
    } catch (e) {
      console.warn('[notifications] Failed to load notified alarms:', e);
    }
  }
  return set;
}

function saveNotifiedAlarms() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(Array.from(notifiedAlarms)));
    } catch (e) {
      console.warn('[notifications] Failed to save notified alarms:', e);
    }
  }
}

const notifiedAlarms = loadNotifiedAlarms();

export function parseTriggerOffsetMs(trigger, startIso) {
  if (!trigger || typeof trigger === 'object') return null;
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }
  if (str.toUpperCase().startsWith('VALUE=DATE-TIME:')) {
    str = str.substring(16).trim();
  }
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return 0;

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (match) {
    const hasComponent = match[2] || match[3] || match[4] || match[5] || match[6];
    if (hasComponent) {
      const sign = match[1] === '-' ? -1 : 1;
      const weeks = parseInt(match[2] || '0', 10);
      const days = parseInt(match[3] || '0', 10);
      const hours = parseInt(match[4] || '0', 10);
      const mins = parseInt(match[5] || '0', 10);
      const secs = parseInt(match[6] || '0', 10);

      const totalMs = ((((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
      return sign * totalMs;
    }
  }

  const absMs = new Date(str).getTime();
  if (!isNaN(absMs)) {
    if (startIso) {
      const startMs = new Date(startIso).getTime();
      if (!isNaN(startMs)) return absMs - startMs;
    }
    return absMs;
  }

  return null;
}

export async function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      const perm = await Notification.requestPermission();
      return perm;
    } catch (e) {
      console.warn('[notifications] Permission request error:', e);
    }
  }
  return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
}

const DURATION_TRIGGER_RE = /^[+-]?P(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/i;

// The moment one alarm fires: an absolute trigger at its own time, a duration from
// the item's start, or from its end for RELATED=END (RFC 5545 §3.8.6.3). NaN if it cannot.
function alarmTimeMs(alarm, item) {
  const trigger = String(alarm.trigger).trim().replace(/^TRIGGER:/i, '').trim();
  if (!DURATION_TRIGGER_RE.test(trigger) && trigger !== '0') {
    return parseTriggerOffsetMs(trigger, null) ?? NaN;
  }
  const relatedEnd = String(alarm.related || '').toUpperCase() === 'END' && item.end;
  const anchorIso = relatedEnd ? item.end : item.start;
  if (!anchorIso) return NaN;
  const offsetMs = parseTriggerOffsetMs(trigger, anchorIso);
  return offsetMs === null ? NaN : new Date(anchorIso).getTime() + offsetMs;
}

function remindAbout(item, now) {
  for (const alarm of item.alarms) {
    if (!alarm.trigger) continue;
    const alarmTime = alarmTimeMs(alarm, item);
    if (isNaN(alarmTime)) continue;
    const relatedEnd = String(alarm.related || '').toUpperCase() === 'END' && item.end;
    const alarmKey = `${item.key}::${relatedEnd ? 'END:' : ''}${alarm.trigger}::${item.start || item.end || ''}`;

    // Trigger if alarmTime has arrived (lookback up to 24 hours for missed alarms) and not yet notified
    if (now >= alarmTime && now <= alarmTime + 24 * 60 * 60 * 1000 && !notifiedAlarms.has(alarmKey)) {
      notifiedAlarms.add(alarmKey);
      saveNotifiedAlarms();

      const title = `Erinnerung: ${item.title}`;
      const timeIso = item.timeIso;
      const timeStr = timeIso ? `${item.timeLabel}: ${new Date(timeIso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : '';
      const locationStr = item.location ? ` | Ort: ${item.location}` : '';
      const descStr = alarm.description ? ` (${alarm.description})` : '';
      const body = `${timeStr}${locationStr}${descStr}`;

      // Trigger Desktop Notification if permitted
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(title, {
            body,
            icon: '/favicon.ico',
            tag: alarmKey
          });
        } catch (err) {
          console.warn('[notifications] Desktop Notification error:', err);
        }
      }

      // Trigger UI Toast fallback
      showToast(`${title} — ${body}`, 'info');
    }
  }
}

export function checkAndTriggerAlarms() {
  const now = Date.now();

  for (const ev of store.get('events') || []) {
    // #174's optimistic preview of a save still in flight has a provisional uid, so its alarm key
    // differs from the stored event's: reminding for it too would fire the same reminder twice
    // (#357), and for a save that fails, about an event that does not exist. The stored event
    // reminds once it has landed.
    if (ev.pending) continue;
    if (!Array.isArray(ev.alarms) || ev.alarms.length === 0 || !ev.start) continue;
    remindAbout({
      key: ev.uid || ev.id, title: ev.title || 'Termin', start: ev.start, end: ev.end,
      location: ev.location, alarms: ev.alarms, timeIso: ev.start, timeLabel: 'Zeit'
    }, now);
  }

  // #508: a task reminds relative to DTSTART, or to DUE for RELATED=END; a finished one does not.
  for (const task of store.get('tasks') || []) {
    if (!Array.isArray(task.alarms) || task.alarms.length === 0 || task.recurrenceId) continue;
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') continue;
    remindAbout({
      key: task.uid, title: task.title || 'Aufgabe', start: task.dtstart, end: task.due,
      alarms: task.alarms, timeIso: task.due, timeLabel: 'Fällig'
    }, now);
  }
}

let _intervalId = null;

export function initNotificationService() {
  if (_intervalId) clearInterval(_intervalId);

  // Register service worker for background push notifications if available
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[notifications] Service Worker registration failed:', err);
    });
  }

  // Run check every 5 seconds
  _intervalId = setInterval(checkAndTriggerAlarms, 5000);
  // Initial check
  checkAndTriggerAlarms();
}

export function resetNotifiedAlarms() {
  notifiedAlarms.clear();
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(NOTIFIED_STORAGE_KEY);
    } catch (e) {
      console.warn('[notifications] Failed to clear notified alarms storage:', e);
    }
  }
}

