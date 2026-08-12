const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTimezoneOffsetMinutes,
  getTimezoneAbbr,
  formatTimezoneHeader,
  getDualHourLabel,
  SUPPORTED_TIMEZONES
} = require('../utils/timezoneGrid');

test('Multi-Timezone Grid Engine Suite', async (t) => {

  await t.test('SUPPORTED_TIMEZONES contains standard IANA timezones', () => {
    assert.ok(Array.isArray(SUPPORTED_TIMEZONES));
    assert.ok(SUPPORTED_TIMEZONES.some(tz => tz.id === 'Europe/Berlin'));
    assert.ok(SUPPORTED_TIMEZONES.some(tz => tz.id === 'America/New_York'));
    assert.ok(SUPPORTED_TIMEZONES.some(tz => tz.id === 'UTC'));
  });

  await t.test('getTimezoneOffsetMinutes returns numeric offset in minutes', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    const berlinOffset = getTimezoneOffsetMinutes('Europe/Berlin', d);
    const utcOffset = getTimezoneOffsetMinutes('UTC', d);
    assert.equal(typeof berlinOffset, 'number');
    assert.equal(utcOffset, 0);
    assert.equal(berlinOffset, 60); // UTC+1 in winter
  });

  await t.test('getTimezoneAbbr returns readable timezone acronym/offset', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    const berlinAbbr = getTimezoneAbbr('Europe/Berlin', d);
    const utcAbbr = getTimezoneAbbr('UTC', d);
    assert.ok(berlinAbbr.includes('CET') || berlinAbbr.includes('GMT+1') || berlinAbbr.includes('+01') || berlinAbbr.includes('UTC+1'));
    assert.ok(utcAbbr.includes('UTC') || utcAbbr.includes('GMT'));
  });

  await t.test('formatTimezoneHeader returns formatted string for dual header', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    const header = formatTimezoneHeader('Europe/Berlin', 'America/New_York', d);
    assert.ok(header.primary.includes('Berlin'));
    assert.ok(header.secondary.includes('New York'));
  });

  await t.test('getDualHourLabel computes accurate hour labels for primary and secondary timezones', () => {
    const d = new Date('2026-01-15T00:00:00Z'); // midnight UTC
    // Base hour 14 in Europe/Berlin (which is 13:00 UTC)
    // In America/New_York (UTC-5), 13:00 UTC is 08:00
    const dualLabel = getDualHourLabel(14, d, 'Europe/Berlin', 'America/New_York');
    assert.equal(dualLabel.primary, '14:00');
    assert.equal(dualLabel.secondary, '08:00');
  });

});
