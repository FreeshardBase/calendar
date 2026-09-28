const ICAL = require('ical.js');
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-4
DTSTART:20100131T090000Z
DTEND:20100131T100000Z
SUMMARY:31st
RRULE:FREQ=MONTHLY;INTERVAL=2
END:VEVENT
END:VCALENDAR`;

const comp = new ICAL.Component(ICAL.parse(ics));
const event = new ICAL.Event(comp.getFirstSubcomponent('vevent'));

let iterStart = event.startDate.clone();
// 198 months later: 16 years, 6 months
iterStart.year = iterStart.year + 16;
iterStart.month = iterStart.month + 6;
if (iterStart.month > 12) {
   iterStart.year += Math.floor((iterStart.month - 1) / 12);
   iterStart.month = ((iterStart.month - 1) % 12) + 1;
}
console.log("IterStart passed:", iterStart.toString());

let iter = event.iterator(iterStart);
console.log(iter.next().toString());
console.log(iter.next().toString());
