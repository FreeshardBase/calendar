'use strict';

// Issue #508: any number of reminders (one VALARM each) per task, and VALARMs
// written by other clients survive a save through the task dialog.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { taskToICS, parseICSToTask, isNoOpTaskSave } = require('../caldav/parser');

function valarms(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  return comp.getFirstSubcomponent('vtodo').getAllSubcomponents('valarm');
}

const FOREIGN = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//Client//EN',
  'BEGIN:VTODO', 'UID:task-508@example.com', 'DTSTAMP:20360101T000000Z', 'SUMMARY:Foreign task',
  'DUE:20360415T120000Z',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER;RELATED=END:-PT1H', 'END:VALARM',
  'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER;RELATED=END:-PT15M', 'REPEAT:2', 'DURATION:PT5M', 'END:VALARM',
  'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Due soon', 'DESCRIPTION:Task due', 'ATTENDEE:mailto:testuser@example.com',
  'TRIGGER;VALUE=DATE-TIME:20360415T080000Z', 'END:VALARM',
  'END:VTODO', 'END:VCALENDAR', ''
].join('\r\n');

test('a new task is written with one VALARM per reminder', () => {
  const ics = taskToICS({
    uid: 'new-508', title: 'Pay bills', due: '2036-04-15T12:00:00.000Z',
    alarms: [
      { action: 'DISPLAY', trigger: '-P1D', related: 'END', description: 'Pay bills' },
      { action: 'DISPLAY', trigger: '20360415T060000Z', description: 'Pay bills' }
    ]
  });
  const comps = valarms(ics);
  assert.equal(comps.length, 2);
  assert.match(ics, /TRIGGER;RELATED=END:-P1D/);
  assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20360415T060000Z/);
  const parsed = parseICSToTask(ics);
  assert.deepEqual(parsed.alarms.map(a => [a.trigger, a.related || null]), [
    ['-P1D', 'END'],
    ['2036-04-15T06:00:00Z', null]
  ]);
});

test('a parsed task carries every VALARM with its action', () => {
  const task = parseICSToTask(FOREIGN);
  assert.deepEqual(task.alarms.map(a => a.action), ['DISPLAY', 'AUDIO', 'EMAIL']);
});

test('saving the parsed reminders back keeps foreign VALARMs with all their properties', () => {
  const task = parseICSToTask(FOREIGN);
  const ics = taskToICS({ ...task, title: 'Renamed' }, FOREIGN);
  const comps = valarms(ics);
  assert.equal(comps.length, 3);
  const audio = comps.find(c => c.getFirstPropertyValue('action') === 'AUDIO');
  assert.equal(audio.getFirstPropertyValue('repeat'), 2);
  assert.equal(audio.getFirstPropertyValue('duration').toString(), 'PT5M');
  const email = comps.find(c => c.getFirstPropertyValue('action') === 'EMAIL');
  assert.equal(email.getFirstPropertyValue('attendee'), 'mailto:testuser@example.com');
  assert.equal(email.getFirstPropertyValue('summary'), 'Due soon');
});

test('removing one reminder and adding another changes exactly those VALARMs', () => {
  const task = parseICSToTask(FOREIGN);
  const alarms = [
    ...task.alarms.filter(a => a.action !== 'DISPLAY'),
    { action: 'DISPLAY', trigger: 'PT30M', related: 'END', description: 'Foreign task' }
  ];
  const ics = taskToICS({ ...task, alarms }, FOREIGN);
  const triggers = valarms(ics).map(c => c.getFirstProperty('trigger').toICALString());
  assert.deepEqual(triggers, [
    'TRIGGER;RELATED=END:-PT15M',
    'TRIGGER;VALUE=DATE-TIME:20360415T080000Z',
    'TRIGGER;RELATED=END:PT30M'
  ]);
});

test('an empty reminder list removes every VALARM; an absent one leaves them alone', () => {
  const task = parseICSToTask(FOREIGN);
  assert.equal(valarms(taskToICS({ ...task, alarms: [] }, FOREIGN)).length, 0);
  const { alarms: _omit, ...withoutAlarms } = task;
  assert.equal(valarms(taskToICS(withoutAlarms, FOREIGN)).length, 3);
});

test('a save that only changes reminders is not a no-op', () => {
  const task = parseICSToTask(FOREIGN);
  assert.equal(isNoOpTaskSave(FOREIGN, { title: task.title, alarms: task.alarms }), true);
  assert.equal(isNoOpTaskSave(FOREIGN, { title: task.title, alarms: task.alarms.slice(1) }), false);
});
