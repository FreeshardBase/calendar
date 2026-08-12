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

  await t.test('getDualHourLabel handles Asia/Tokyo, Europe/London, and UTC conversions', () => {
    const d = new Date('2026-07-15T12:00:00Z'); // Summer (CEST: UTC+2, BST: UTC+1, JST: UTC+9)
    // Primary: Europe/Berlin (CEST, UTC+2), Secondary: Asia/Tokyo (JST, UTC+9) -> diff +7h
    const labelTokyo = getDualHourLabel(10, d, 'Europe/Berlin', 'Asia/Tokyo');
    assert.equal(labelTokyo.primary, '10:00');
    assert.equal(labelTokyo.secondary, '17:00');

    // Primary: Europe/Berlin (CEST, UTC+2), Secondary: Europe/London (BST, UTC+1) -> diff -1h
    const labelLondon = getDualHourLabel(10, d, 'Europe/Berlin', 'Europe/London');
    assert.equal(labelLondon.primary, '10:00');
    assert.equal(labelLondon.secondary, '09:00');

    // Primary: Europe/Berlin (CEST, UTC+2), Secondary: UTC -> diff -2h
    const labelUTC = getDualHourLabel(10, d, 'Europe/Berlin', 'UTC');
    assert.equal(labelUTC.primary, '10:00');
    assert.equal(labelUTC.secondary, '08:00');
  });

  await t.test('getDualHourLabel handles 24-hour wraparound across midnight', () => {
    const d = new Date('2026-01-15T00:00:00Z');
    // Primary: Europe/Berlin (UTC+1), Secondary: Asia/Tokyo (UTC+9) -> diff +8h
    // Hour 20 in Berlin -> 04:00 next day in Tokyo
    const wrap = getDualHourLabel(20, d, 'Europe/Berlin', 'Asia/Tokyo');
    assert.equal(wrap.primary, '20:00');
    assert.equal(wrap.secondary, '04:00');
  });

});
