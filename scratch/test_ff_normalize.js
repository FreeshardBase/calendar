const ICAL = require('ical.js');
let t = ICAL.Time.fromString('2010-01-01T09:00:00Z');
t.day += 6000;
t.normalize();
console.log(t.toString());
