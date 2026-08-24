'use strict';

window.WorkingHoursModule = {
  policy: null,

  async init() {
    this.bindEvents();
    await this.loadPolicy();
  },

  bindEvents() {
    const saveBtn = document.getElementById('wh-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.savePolicy());
    }

    const oooToggle = document.getElementById('wh-ooo-enabled');
    const oooFields = document.getElementById('wh-ooo-fields');
    if (oooToggle && oooFields) {
      oooToggle.addEventListener('change', () => {
        oooFields.style.display = oooToggle.checked ? 'block' : 'none';
      });
    }
  },

  async loadPolicy() {
    try {
      const res = await fetch('/api/working-hours');
      if (!res.ok) return;
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
        if (oooFields) oooFields.style.display = policy.oooEnabled ? 'block' : 'none';
      }
      if (oooStartInput) oooStartInput.value = policy.oooStart || '';
      if (oooEndInput) oooEndInput.value = policy.oooEnd || '';
      if (oooMsgInput) oooMsgInput.value = policy.oooMessage || 'Out of Office / Abwesend';

      // Work days checkboxes (1=Mon ... 5=Fri, 6=Sat, 0=Sun)
      const activeDays = (policy.workDays || '1,2,3,4,5').split(',');
      for (let day = 0; day <= 6; day++) {
        const cb = document.getElementById(`wh-day-${day}`);
        if (cb) {
          cb.checked = activeDays.includes(String(day));
        }
      }
    } catch (e) {
      console.error('[WorkingHours] Failed to load policy:', e);
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
        oooMessage: oooMsgInput ? oooMsgInput.value : 'Out of Office / Abwesend'
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
      const statusEl = document.getElementById('wh-save-status');
      if (statusEl) {
        statusEl.textContent = 'Gespeichert!';
        statusEl.style.color = '#10b981';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      }
    } catch (e) {
      console.error('[WorkingHours] Save error:', e);
      const statusEl = document.getElementById('wh-save-status');
      if (statusEl) {
        statusEl.textContent = 'Fehler beim Speichern!';
        statusEl.style.color = '#ef4444';
      }
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
