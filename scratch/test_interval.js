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

let iterStart = event.startDate.clone();
iterStart.year = 2026;
iterStart.month = 8;
iterStart.day = 1;

let iter = event.iterator(iterStart);
console.log(iter.next().toString());
console.log(iter.next().toString());
