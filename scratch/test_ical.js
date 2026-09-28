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

const jcal = ICAL.parse(ics);
const comp = new ICAL.Component(jcal);
const vevent = comp.getFirstSubcomponent('vevent');
const event = new ICAL.Event(vevent);

const iter = event.iterator();
console.time('iterate 50000');
let next;
for (let i = 0; i < 50000; i++) {
  next = iter.next();
}
console.timeEnd('iterate 50000');
console.log(next.toString());
