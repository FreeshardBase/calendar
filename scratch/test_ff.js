const ICAL = require('ical.js');
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-2
DTSTART:20100101T090000Z
DTEND:20100101T100000Z
SUMMARY:Fortnightly
RRULE:FREQ=WEEKLY;INTERVAL=2
END:VEVENT
END:VCALENDAR`;

const comp = new ICAL.Component(ICAL.parse(ics));
const event = new ICAL.Event(comp.getFirstSubcomponent('vevent'));

// We want to skip to around 2026-08-01.
// 2010-01-01 to 2026-08-01 is 6056 days.
const start = new Date('2010-01-01T09:00:00Z');
const limit = new Date('2026-08-01T00:00:00Z');
const deltaMs = limit.getTime() - start.getTime();
const deltaDays = deltaMs / (1000 * 60 * 60 * 24);

const interval = 2; // from RRULE
const deltaWeeks = deltaDays / 7;
const intervalsPassed = Math.floor(deltaWeeks / interval);
const daysToAdd = intervalsPassed * interval * 7;

const exactIterStart = new Date(start.getTime() + daysToAdd * 24 * 60 * 60 * 1000);

let iterStart = ICAL.Time.fromJSDate(exactIterStart, true);
console.log("Exact IterStart:", iterStart.toString());

let iter = event.iterator(iterStart);
console.log(iter.next().toString());
console.log(iter.next().toString());
