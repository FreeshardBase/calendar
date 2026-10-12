/**
 * booking.js — public booking page (booking.html). Kept out of the HTML so
 * the CSP can forbid inline scripts (issue #338).
 */
import { AvailabilityAPI } from '/js/api.js';

const params = new URLSearchParams(window.location.search);
const slug = params.get('slug') || window.location.pathname.split('/').pop();

const loadingEl = document.getElementById('booking-loading');
const errorEl = document.getElementById('booking-error');
const contentEl = document.getElementById('booking-content');
const dateInput = document.getElementById('booking-date');
const slotsContainer = document.getElementById('slots-container');
const formWrapper = document.getElementById('booking-form-wrapper');
const successBox = document.getElementById('booking-success');
const bookingForm = document.getElementById('public-booking-form');

// Default to today's date, or next business day (Monday) if weekend
const now = new Date();
const today = now.toISOString().split('T')[0];
if (now.getDay() === 0) { // Sunday -> advance to Monday
  now.setDate(now.getDate() + 1);
} else if (now.getDay() === 6) { // Saturday -> advance to Monday
  now.setDate(now.getDate() + 2);
}
const defaultDate = now.toISOString().split('T')[0];
dateInput.value = defaultDate;
dateInput.min = today;

let selectedSlotTime = null;

async function loadSlots() {
  try {
    slotsContainer.innerHTML = '<p class="empty-state">Zeitslots werden geladen…</p>';
    const data = await AvailabilityAPI.getPublicPage(slug, dateInput.value);

    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    document.getElementById('page-title').textContent = data.title;
    document.getElementById('page-meta').textContent = `Dauer: ${data.durationMinutes} Minuten`;

    if (!data.availableSlots || data.availableSlots.length === 0) {
      slotsContainer.innerHTML = '<p class="empty-state">An diesem Tag sind keine freien Zeitslots verfügbar.</p>';
      formWrapper.classList.add('hidden');
      return;
    }

    slotsContainer.innerHTML = data.availableSlots.map(slot => {
      const timeLabel = new Date(slot.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      return `<button class="slot-btn" data-time="${slot.startTime}">${timeLabel} Uhr</button>`;
    }).join('');

    slotsContainer.querySelectorAll('.slot-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        slotsContainer.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedSlotTime = btn.getAttribute('data-time');
        document.getElementById('selected-start-time').value = selectedSlotTime;
        formWrapper.classList.remove('hidden');
        formWrapper.scrollIntoView({ behavior: 'smooth' });
      });
    });
  } catch (err) {
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    document.getElementById('error-message').textContent = err.message || 'Buchungsseite konnte nicht geladen werden.';
  }
}

dateInput.addEventListener('change', () => {
  formWrapper.classList.add('hidden');
  selectedSlotTime = null;
  loadSlots();
});

bookingForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedSlotTime) return;

  const guestName = document.getElementById('guest-name').value;
  const guestEmail = document.getElementById('guest-email').value;
  const notes = document.getElementById('guest-notes').value;

  try {
    const confirmBtn = document.getElementById('confirm-booking-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Wird gebucht…';

    await AvailabilityAPI.bookPublicSlot(slug, {
      startTime: selectedSlotTime,
      guestName,
      guestEmail,
      notes
    });

    formWrapper.classList.add('hidden');
    slotsContainer.innerHTML = '';
    successBox.classList.remove('hidden');
  } catch (err) {
    alert(err.message || 'Fehler bei der Buchung');
    const confirmBtn = document.getElementById('confirm-booking-btn');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Termin verbindlich buchen';
  }
});

loadSlots();
