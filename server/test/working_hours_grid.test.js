'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3295';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('assert');
const { isHourInWorkingHours, evaluateWorkingHoursPolicy } = require('../utils/workingHoursPolicy');

test('Working Hours Configuration & Grid Shading Suite', async (t) => {
  await t.test('isHourInWorkingHours utility logic', () => {
    const policy = {
      startHour: 9,
      endHour: 17,
      workDays: '1,2,3,4,5' // Mon-Fri
    };

    // Monday (2026-08-10) at 10:00 (hour 10) -> inside working hours
    const mon10 = new Date('2026-08-10T10:00:00Z');
    assert.strictEqual(isHourInWorkingHours(mon10, 10, policy), true);

    // Monday at 8:00 (hour 8) -> before start hour
    assert.strictEqual(isHourInWorkingHours(mon10, 8, policy), false);

    // Monday at 17:00 (hour 17) -> at/after end hour
    assert.strictEqual(isHourInWorkingHours(mon10, 17, policy), false);

    // Sunday (2026-08-16) at 12:00 -> non-work day
    const sun12 = new Date('2026-08-16T12:00:00Z');
    assert.strictEqual(isHourInWorkingHours(sun12, 12, policy), false);
  });

  await t.test('isHourInWorkingHours fallback defaults', () => {
    const mon10 = new Date('2026-08-10T10:00:00Z');
    // Null policy uses default 9-17 Mon-Fri
    assert.strictEqual(isHourInWorkingHours(mon10, 10, null), true);
    assert.strictEqual(isHourInWorkingHours(mon10, 7, null), false);
  });

  await t.test('Custom workDays configuration', () => {
    const customPolicy = {
      startHour: 8,
      endHour: 14,
      workDays: '6,0' // Sat, Sun only
    };

    const sat10 = new Date('2026-08-15T10:00:00Z'); // Saturday
    assert.strictEqual(isHourInWorkingHours(sat10, 10, customPolicy), true);
    assert.strictEqual(isHourInWorkingHours(sat10, 15, customPolicy), false);

    const mon10 = new Date('2026-08-10T10:00:00Z'); // Monday
    assert.strictEqual(isHourInWorkingHours(mon10, 10, customPolicy), false);
  });
});
