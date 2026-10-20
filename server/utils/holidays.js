'use strict';

// Issue #514: public holidays, computed on the shard from the statutory rules — no third-party
// request (CONCEPTS.md "Holidays"). Germany with its sixteen states, keyed by ISO 3166-2 code.
// Holidays that apply only to some municipalities of a state (Mariä Himmelfahrt in parts of
// Bavaria, Fronleichnam in parts of Saxony and Thuringia, the Augsburg peace festival) are left out.

const ALL = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];

const STATE_NAMES = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen',
  HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen',
  ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

const HOLIDAY_COUNTRIES = [{
  code: 'DE',
  name: 'Deutschland',
  regions: Object.entries(STATE_NAMES)
    .map(([code, name]) => ({ code: `DE-${code}`, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de')),
}];

// Easter Sunday (Gregorian), anonymous algorithm (Meeus/Jones/Butcher); month is 1-based.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

const DAY = 24 * 60 * 60 * 1000;
const fixed = (month, day) => year => Date.UTC(year, month - 1, day);
const easter = offset => year => easterSunday(year) + offset * DAY;
// Buß- und Bettag: the Wednesday before 23 November.
const repentanceDay = year => {
  const nov23 = Date.UTC(year, 10, 23);
  const back = (new Date(nov23).getUTCDay() - 3 + 7) % 7 || 7;
  return nov23 - back * DAY;
};

// [name, date rule, states, first year it applies]
const RULES = [
  ['Neujahr', fixed(1, 1), ALL],
  ['Heilige Drei Könige', fixed(1, 6), ['BW', 'BY', 'ST']],
  ['Internationaler Frauentag', fixed(3, 8), ['BE'], 2019],
  ['Internationaler Frauentag', fixed(3, 8), ['MV'], 2023],
  ['Karfreitag', easter(-2), ALL],
  ['Ostersonntag', easter(0), ['BB']],
  ['Ostermontag', easter(1), ALL],
  ['Tag der Arbeit', fixed(5, 1), ALL],
  ['Christi Himmelfahrt', easter(39), ALL],
  ['Pfingstsonntag', easter(49), ['BB']],
  ['Pfingstmontag', easter(50), ALL],
  ['Fronleichnam', easter(60), ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']],
  ['Mariä Himmelfahrt', fixed(8, 15), ['SL']],
  ['Weltkindertag', fixed(9, 20), ['TH'], 2019],
  ['Tag der Deutschen Einheit', fixed(10, 3), ALL],
  ['Reformationstag', fixed(10, 31), ['BB', 'MV', 'SN', 'ST', 'TH']],
  ['Reformationstag', fixed(10, 31), ['HB', 'HH', 'NI', 'SH'], 2018],
  ['Allerheiligen', fixed(11, 1), ['BW', 'BY', 'NW', 'RP', 'SL']],
  ['Buß- und Bettag', repentanceDay, ['SN']],
  ['1. Weihnachtstag', fixed(12, 25), ALL],
  ['2. Weihnachtstag', fixed(12, 26), ALL],
];

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

function isHolidayRegion(region) {
  return typeof region === 'string' && region.startsWith('DE-') && Object.hasOwn(STATE_NAMES, region.slice(3));
}

function regionName(region) {
  if (!isHolidayRegion(region)) throw new Error(`Unknown holiday region: ${region}`);
  return STATE_NAMES[region.slice(3)];
}

/**
 * The region's holidays from `from` to `to` (both 'YYYY-MM-DD', inclusive), sorted by date.
 * @returns {{ date: string, name: string }[]}
 */
function holidaysInRange(region, from, to) {
  regionName(region);
  const state = region.slice(3);
  const out = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const [name, rule, states, since] of RULES) {
      if (!states.includes(state) || (since && year < since)) continue;
      const date = isoDate(rule(year));
      if (date >= from && date <= to) out.push({ date, name });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { HOLIDAY_COUNTRIES, isHolidayRegion, regionName, holidaysInRange };
