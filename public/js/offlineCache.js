/**
 * OfflineCache — Client-side local caching and offline detection module for WebCalendar
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OfflineCache = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  const CALENDARS_KEY = 'webcalendar_offline_calendars';
  const EVENTS_PREFIX = 'webcalendar_offline_events_';
  const TASKS_KEY = 'webcalendar_offline_tasks';

  let offlineOverride = false;

  function getStorage() {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
    return null;
  }

  function isOffline() {
    if (offlineOverride) return true;
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return !navigator.onLine;
    }
    return false;
  }

  function setOfflineStatus(status) {
    offlineOverride = Boolean(status);
  }

  function saveCalendars(calendars) {
    const storage = getStorage();
    if (!storage || !Array.isArray(calendars)) return;
    try {
      storage.setItem(CALENDARS_KEY, JSON.stringify(calendars));
    } catch (e) {
      console.warn('OfflineCache: Failed to save calendars', e);
    }
  }

  function getCalendars() {
    const storage = getStorage();
    if (!storage) return [];
    try {
      const data = storage.getItem(CALENDARS_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.warn('OfflineCache: Failed to retrieve calendars', e);
      return [];
    }
  }

  function saveEvents(calendarId, events) {
    const storage = getStorage();
    if (!storage || !calendarId || !Array.isArray(events)) return;
    try {
      storage.setItem(EVENTS_PREFIX + calendarId, JSON.stringify(events));
    } catch (e) {
      console.warn('OfflineCache: Failed to save events', e);
    }
  }

  function getEvents(calendarId) {
    const storage = getStorage();
    if (!storage || !calendarId) return [];
    try {
      const data = storage.getItem(EVENTS_PREFIX + calendarId);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.warn('OfflineCache: Failed to retrieve events', e);
      return [];
    }
  }

  function saveTasks(tasks) {
    const storage = getStorage();
    if (!storage || !Array.isArray(tasks)) return;
    try {
      storage.setItem(TASKS_KEY, JSON.stringify(tasks));
    } catch (e) {
      console.warn('OfflineCache: Failed to save tasks', e);
    }
  }

  function getTasks() {
    const storage = getStorage();
    if (!storage) return [];
    try {
      const data = storage.getItem(TASKS_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.warn('OfflineCache: Failed to retrieve tasks', e);
      return [];
    }
  }

  // #571: a newly deployed worker means a new version; the page still runs the code it loaded, so it
  // offers a reload instead of reloading under the user's input. #583: the offer follows the new
  // worker's install, not its takeover: the browser activates it only once the old worker has no
  // fetch in flight (Chromium sometimes much later), and the app shell is network-first, so the
  // reload runs the new version whichever worker controls the page. On a first visit there is no
  // active worker and the page already runs the current code. A reload while the new worker still
  // waits can hang in Chromium, so the button first lets it take over.
  function offerReloadOnNewVersion(reg) {
    document.getElementById('update-reload-btn').addEventListener('click', () => {
      const waiting = reg.waiting;
      if (!waiting) {
        window.location.reload();
        return;
      }
      waiting.addEventListener('statechange', () => window.location.reload(), { once: true });
      waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    reg.addEventListener('updatefound', () => {
      if (!reg.active) return;
      const worker = reg.installing;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
          document.getElementById('update-banner').classList.remove('hidden');
        }
      });
    });
  }

  function registerServiceWorker() {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then((reg) => {
            console.log('OfflineCache: Service Worker registered successfully', reg.scope);
            offerReloadOnNewVersion(reg);
          })
          .catch((err) => {
            console.warn('OfflineCache: Service Worker registration failed', err);
          });
      });
    }
  }

  function initOfflineListeners(onStatusChange) {
    if (typeof window === 'undefined') return;

    function updateOnlineState() {
      const offline = isOffline();
      const banner = document.getElementById('offline-status-banner');
      if (banner) {
        banner.style.display = offline ? 'block' : 'none';
      }
      if (typeof onStatusChange === 'function') {
        onStatusChange(offline);
      }
    }

    window.addEventListener('online', updateOnlineState);
    window.addEventListener('offline', updateOnlineState);
    updateOnlineState();
  }

  return {
    isOffline,
    setOfflineStatus,
    saveCalendars,
    getCalendars,
    saveEvents,
    getEvents,
    saveTasks,
    getTasks,
    registerServiceWorker,
    initOfflineListeners
  };
}));
