'use strict';

/**
 * Calculates available time slots for a given availability page config and date.
 * 
 * @param {Object} pageConfig
 * @param {number} pageConfig.durationMinutes
 * @param {number} pageConfig.startHour
 * @param {number} pageConfig.endHour
 * @param {string} pageConfig.daysOfWeek - e.g. "1,2,3,4,5" (0=Sun, 1=Mon, ..., 6=Sat)
 * @param {Array<{start: string, end: string}>} existingEvents
 * @param {Array<{start_time: string, end_time: string}>} existingBookings
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {Array<{startTime: string, endTime: string}>}
 */
function calculateFreeSlots(pageConfig, existingEvents = [], existingBookings = [], dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return [];
  }

  const durationMinutes = parseInt(pageConfig.durationMinutes, 10) || 30;
  const startHour = parseInt(pageConfig.startHour, 10) ?? 9;
  const endHour = parseInt(pageConfig.endHour, 10) ?? 17;
  const allowedDays = (pageConfig.daysOfWeek || '1,2,3,4,5')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const targetDate = new Date(`${dateStr}T00:00:00.000Z`);
  if (isNaN(targetDate.getTime())) {
    return [];
  }

  const dayOfWeek = targetDate.getUTCDay();
  if (!allowedDays.includes(dayOfWeek)) {
    return [];
  }

  const availableSlots = [];
  const totalStartMinutes = startHour * 60;
  const totalEndMinutes = endHour * 60;

  for (let currentMin = totalStartMinutes; currentMin + durationMinutes <= totalEndMinutes; currentMin += durationMinutes) {
    const slotStartHour = Math.floor(currentMin / 60);
    const slotStartMin = currentMin % 60;
    const slotEndHour = Math.floor((currentMin + durationMinutes) / 60);
    const slotEndMin = (currentMin + durationMinutes) % 60;

    const pad = (n) => String(n).padStart(2, '0');

    const startTimeISO = `${dateStr}T${pad(slotStartHour)}:${pad(slotStartMin)}:00.000Z`;
    const endTimeISO = `${dateStr}T${pad(slotEndHour)}:${pad(slotEndMin)}:00.000Z`;

    const slotStartMs = new Date(startTimeISO).getTime();
    const slotEndMs = new Date(endTimeISO).getTime();

    // Check collision with calendar events
    const eventOverlap = existingEvents.some(ev => {
      const evStartMs = new Date(ev.start).getTime();
      const evEndMs = new Date(ev.end).getTime();
      return evStartMs < slotEndMs && evEndMs > slotStartMs;
    });

    if (eventOverlap) {
      continue;
    }

    // Check collision with existing slot bookings
    const bookingOverlap = existingBookings.some(b => {
      const bStart = b.startTime || b.start_time;
      const bEnd = b.endTime || b.end_time;
      const bStartMs = new Date(bStart).getTime();
      const bEndMs = new Date(bEnd).getTime();
      return bStartMs < slotEndMs && bEndMs > slotStartMs;
    });

    if (bookingOverlap) {
      continue;
    }

    availableSlots.push({
      startTime: startTimeISO,
      endTime: endTimeISO
    });
  }

  return availableSlots;
}

module.exports = {
  calculateFreeSlots
};
