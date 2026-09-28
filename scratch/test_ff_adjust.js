const ICAL = require('ical.js');
let t = ICAL.Time.fromString('2010-01-01T09:00:00Z');
t.adjust(6000, 0, 0, 0);
console.log(t.toString());
