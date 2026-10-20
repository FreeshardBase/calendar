/**
 * booking.js — public booking page (booking.html). Kept out of the HTML so
 * the CSP can forbid inline scripts (issue #338). Served to anonymous
 * visitors as /public/booking/booking.js (#480), so its imports resolve there too.
 */
import { AvailabilityAPI } from './api.js';
import { t, setLanguage, browserLanguage } from './i18n.js';

// #627: a visitor has no settings; the page speaks the browser's language, else Deutsch (Du).
setLanguage(browserLanguage());

const slug = new URLSearchParams(window.location.search).get('slug');

const loadingEl = document.getElementById('booking-loading');
const errorEl = document.getElementById('booking-error');
const contentEl = document.getElementById('booking-content');
const dateInput = document.getElementById('booking-date');
const slotsContainer = document.getElementById('slots-container');
const formWrapper = document.getElementById('booking-form-wrapper');
const successBox = document.getElementById('booking-success');
const bookingForm = document.getElementById('public-booking-form');

const escHtml = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Default to today's date, or next business day (Monday) if weekend
// #625: the visitor's local calendar date, never the UTC date of toISOString().
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const today = localDay(now);
if (now.getDay() === 0) { // Sunday -> advance to Monday
  now.setDate(now.getDate() + 1);
} else if (now.getDay() === 6) { // Saturday -> advance to Monday
  now.setDate(now.getDate() + 2);
}
const defaultDate = localDay(now);
dateInput.value = defaultDate;
dateInput.min = today;

let selectedSlotTime = null;

async function loadSlots() {
  try {
    slotsContainer.innerHTML = `<p class="empty-state">${escHtml(t('booking.slots.loading'))}</p>`;
    const data = await AvailabilityAPI.getPublicPage(slug, dateInput.value);

    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    document.getElementById('page-title').textContent = data.title;
    document.getElementById('page-meta').textContent = t('booking.duration', { count: data.durationMinutes });

    if (!data.availableSlots || data.availableSlots.length === 0) {
      slotsContainer.innerHTML = `<p class="empty-state">${escHtml(t('booking.slots.none'))}</p>`;
      formWrapper.classList.add('hidden');
      return;
    }

    slotsContainer.innerHTML = data.availableSlots.map(slot => {
      const time = new Date(slot.startTime).toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      return `<button class="slot-btn" data-time="${escHtml(slot.startTime)}">${escHtml(t('booking.slots.time', { time }))}</button>`;
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
    document.getElementById('error-message').textContent = bookingError(err, 'booking.error.load');
  }
}

// #627: the server's error texts are German; a visitor reads the known ones in the page's language.
const ERROR_BY_STATUS = { 400: 'booking.error.invalidDate', 404: 'booking.error.notFound', 409: 'booking.error.slotTaken' };

function bookingError(err, fallbackKey) {
  if (ERROR_BY_STATUS[err.status]) return t(ERROR_BY_STATUS[err.status]);
  return `${t(fallbackKey)} (${err.message})`;
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
    confirmBtn.textContent = t('booking.form.submitting');

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
    alert(bookingError(err, 'booking.error.book'));
    const confirmBtn = document.getElementById('confirm-booking-btn');
    confirmBtn.disabled = false;
    confirmBtn.textContent = t('booking.form.submit');
  }
});

loadSlots();
