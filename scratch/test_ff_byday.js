const ICAL = require('ical.js');

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-3
DTSTART:20100101T090000Z
DTEND:20100101T100000Z
SUMMARY:First Friday
RRULE:FREQ=MONTHLY;BYDAY=1FR;INTERVAL=2
END:VEVENT
END:VCALENDAR`;

const comp = new ICAL.Component(ICAL.parse(ics));
const event = new ICAL.Event(comp.getFirstSubcomponent('vevent'));

const start = new Date('2010-01-01T09:00:00Z');
const fastForward = new Date('2026-08-01T00:00:00Z');
const interval = 2;

const deltaMonths = (fastForward.getUTCFullYear() - start.getUTCFullYear()) * 12 + (fastForward.getUTCMonth() - start.getUTCMonth());
const intervalsPassed = Math.floor(deltaMonths / interval);

const exactIterStart = new Date(start);
exactIterStart.setUTCMonth(start.getUTCMonth() + intervalsPassed * interval);

let iterStart = ICAL.Time.fromJSDate(exactIterStart, true);
console.log("IterStart passed:", iterStart.toString());

let iter = event.iterator(iterStart);
console.log(iter.next().toString());
console.log(iter.next().toString());
