'use strict';

// #627: a classic script cannot import; it loads the same i18n.js module instance app.js uses.
const workingHoursI18n = import(new URL('i18n.js', document.currentScript.src).href);

window.WorkingHoursModule = {
  policy: null,
  // The message key and colour of the save status line, redrawn on a language change.
  status: null,

  async init() {
    this.bindEvents();
    await this.loadPolicy();
  },

  async showStatus(key, color) {
    const { t } = await workingHoursI18n;
    this.status = key && { key, color };
    const statusEl = document.getElementById('wh-save-status');
    if (!statusEl) return;
    statusEl.textContent = key ? t(key) : '';
    if (color) statusEl.style.color = color;
  },

  bindEvents() {
    window.addEventListener('ui-language-changed', () => {
      if (this.status) this.showStatus(this.status.key, this.status.color);
    });

    const saveBtn = document.getElementById('wh-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.savePolicy());
    }

    const oooToggle = document.getElementById('wh-ooo-enabled');
    const oooFields = document.getElementById('wh-ooo-fields');
    if (oooToggle && oooFields) {
      oooToggle.addEventListener('change', () => {
        oooFields.classList.toggle('hidden', !oooToggle.checked);
      });
    }
  },

  async loadPolicy() {
    const saveBtn = document.getElementById('wh-save-btn');
    try {
      const res = await fetch('/api/working-hours');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const policy = await res.json();
      this.policy = policy;
      if (window.__appStore) {
        window.__appStore.set({ workingHours: policy });
      }

      const startSelect = document.getElementById('wh-start-hour');
      const endSelect = document.getElementById('wh-end-hour');
      const autoDeclineToggle = document.getElementById('wh-auto-decline');
      const oooToggle = document.getElementById('wh-ooo-enabled');
      const oooFields = document.getElementById('wh-ooo-fields');
      const oooStartInput = document.getElementById('wh-ooo-start');
      const oooEndInput = document.getElementById('wh-ooo-end');
      const oooMsgInput = document.getElementById('wh-ooo-message');

      if (startSelect) startSelect.value = policy.startHour;
      if (endSelect) endSelect.value = policy.endHour;
      if (autoDeclineToggle) autoDeclineToggle.checked = !!policy.autoDecline;
      if (oooToggle) {
        oooToggle.checked = !!policy.oooEnabled;
        if (oooFields) oooFields.classList.toggle('hidden', !policy.oooEnabled);
      }
      if (oooStartInput) oooStartInput.value = policy.oooStart || '';
      if (oooEndInput) oooEndInput.value = policy.oooEnd || '';
      const { t } = await workingHoursI18n;
      if (oooMsgInput) oooMsgInput.value = policy.oooMessage || t('views.workingHours.oooDefault');

      // Work days checkboxes (1=Mon ... 5=Fri, 6=Sat, 0=Sun)
      const activeDays = (policy.workDays || '1,2,3,4,5').split(',');
      for (let day = 0; day <= 6; day++) {
        const cb = document.getElementById(`wh-day-${day}`);
        if (cb) {
          cb.checked = activeDays.includes(String(day));
        }
      }
      if (saveBtn) saveBtn.disabled = false;
    } catch (e) {
      // #343: the form still shows defaults; saving them would overwrite the stored policy.
      console.error('[WorkingHours] Failed to load policy:', e);
      if (saveBtn) saveBtn.disabled = true;
      await this.showStatus('views.workingHours.loadError', '#ef4444');
    }
  },

  async savePolicy() {
    try {
      const startSelect = document.getElementById('wh-start-hour');
      const endSelect = document.getElementById('wh-end-hour');
      const autoDeclineToggle = document.getElementById('wh-auto-decline');
      const oooToggle = document.getElementById('wh-ooo-enabled');
      const oooStartInput = document.getElementById('wh-ooo-start');
      const oooEndInput = document.getElementById('wh-ooo-end');
      const oooMsgInput = document.getElementById('wh-ooo-message');

      const selectedDays = [];
      for (let day = 0; day <= 6; day++) {
        const cb = document.getElementById(`wh-day-${day}`);
        if (cb && cb.checked) {
          selectedDays.push(day);
        }
      }

      const body = {
        startHour: parseInt(startSelect ? startSelect.value : 9, 10),
        endHour: parseInt(endSelect ? endSelect.value : 17, 10),
        workDays: selectedDays.join(','),
        autoDecline: autoDeclineToggle && autoDeclineToggle.checked ? 1 : 0,
        oooEnabled: oooToggle && oooToggle.checked ? 1 : 0,
        oooStart: oooStartInput ? oooStartInput.value : '',
        oooEnd: oooEndInput ? oooEndInput.value : '',
        oooMessage: oooMsgInput ? oooMsgInput.value : (await workingHoursI18n).t('views.workingHours.oooDefault')
      };

      const res = await fetch('/api/working-hours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error('Speichern fehlgeschlagen');
      }

      const data = await res.json();
      this.policy = data.policy;
      if (window.__appStore) {
        window.__appStore.set({ workingHours: data.policy });
      }
      await this.showStatus('views.workingHours.saved', '#10b981');
      setTimeout(() => {
        if (this.status?.key === 'views.workingHours.saved') this.showStatus(null);
      }, 3000);
    } catch (e) {
      console.error('[WorkingHours] Save error:', e);
      await this.showStatus('views.workingHours.saveError', '#ef4444');
    }
  },

  isHourInWorkingHours(dateVal, hour) {
    const policy = this.policy || (window.__appStore ? window.__appStore.get('workingHours') : null) || { startHour: 9, endHour: 17, workDays: '1,2,3,4,5' };
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return false;
    const workDays = (policy.workDays || '1,2,3,4,5').split(',').map(n => parseInt(n.trim(), 10));
    const startHour = policy.startHour !== undefined ? Number(policy.startHour) : 9;
    const endHour = policy.endHour !== undefined ? Number(policy.endHour) : 17;
    const dayOfWeek = d.getDay();
    return workDays.includes(dayOfWeek) && hour >= startHour && hour < endHour;
  },

  async evaluateEvent(startTime, endTime) {
    try {
      const res = await fetch('/api/working-hours/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startTime, endTime })
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }
};
