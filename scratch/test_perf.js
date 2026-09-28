const ICAL = require('ical.js');

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-2
DTSTART:20100101T090000Z
DTEND:20100101T100000Z
SUMMARY:Fortnightly
RRULE:FREQ=MINUTELY;INTERVAL=1
END:VEVENT
END:VCALENDAR`;

const comp = new ICAL.Component(ICAL.parse(ics));
const event = new ICAL.Event(comp.getFirstSubcomponent('vevent'));
const limitStart = new Date('2026-08-01T00:00:00Z').getTime();

const iter = event.iterator();
console.time('iterate minutely to 2026');
let next;
let count = 0;
while (true) {
  next = iter.next();
  count++;
  if (!next || next.toJSDate().getTime() > limitStart) break;
  if (count > 2000000) {
     console.log('Hit 2,000,000');
     break;
  }
}
console.timeEnd('iterate minutely to 2026');
console.log('Iterations:', count);
console.log('Next:', next ? next.toString() : null);
