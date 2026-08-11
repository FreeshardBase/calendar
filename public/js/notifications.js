/**
 * notifications.js — Browser Push & Desktop Notification Manager for VALARM Triggers.
 */

import { store } from './store.js';
import { showToast } from './app.js';

const notifiedAlarms = new Set();

export function parseTriggerOffsetMs(trigger) {
  if (!trigger) return -15 * 60 * 1000;
  let str = String(trigger).trim();
  if (str.toUpperCase().startsWith('TRIGGER:')) {
    str = str.substring(8).trim();
  }
  if (str === 'PT0S' || str === 'PT0M' || str === '0') return 0;

  const match = str.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return -15 * 60 * 1000;

  const sign = match[1] === '-' ? -1 : 1;
  const weeks = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  const hours = parseInt(match[4] || '0', 10);
  const mins = parseInt(match[5] || '0', 10);
  const secs = parseInt(match[6] || '0', 10);

  const totalMs = ((((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
  return sign * totalMs;
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

export function checkAndTriggerAlarms() {
  const events = store.get('events') || [];
  const now = Date.now();

  for (const ev of events) {
    if (!ev.alarms || !Array.isArray(ev.alarms) || ev.alarms.length === 0) continue;
    if (!ev.start) continue;

    const startMs = new Date(ev.start).getTime();
    if (isNaN(startMs)) continue;

    for (const alarm of ev.alarms) {
      const offsetMs = parseTriggerOffsetMs(alarm.trigger);
      const alarmTime = startMs + offsetMs;
      const alarmKey = `${ev.uid || ev.id}::${alarm.trigger}::${ev.start}`;

      // Trigger if alarmTime has arrived within recent window (last 5 minutes) and not yet notified
      if (now >= alarmTime && now <= alarmTime + 5 * 60 * 1000 && !notifiedAlarms.has(alarmKey)) {
        notifiedAlarms.add(alarmKey);

        const title = `⏰ Erinnerung: ${ev.title || 'Termin'}`;
        const timeStr = new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const locationStr = ev.location ? ` | 📍 Ort: ${ev.location}` : '';
        const descStr = alarm.description ? ` (${alarm.description})` : '';
        const body = `Zeit: ${timeStr}${locationStr}${descStr}`;

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
}

let _intervalId = null;

export function initNotificationService() {
  if (_intervalId) clearInterval(_intervalId);

  // Request permission on user interaction if appropriate
  requestNotificationPermission();

  // Run check every 5 seconds
  _intervalId = setInterval(checkAndTriggerAlarms, 5000);
  // Initial check
  checkAndTriggerAlarms();
}

export function resetNotifiedAlarms() {
  notifiedAlarms.clear();
}

