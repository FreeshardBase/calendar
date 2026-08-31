'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileTaskStatus, taskToICS, parseICSToTask } = require('../caldav/parser');

test('Issue #94 — STATUS, COMPLETED and PERCENT-COMPLETE Reconciliation Suite', async (t) => {

  await t.test('reconcileTaskStatus: completes task when status is COMPLETED', () => {
    const task = { title: 'Test', status: 'COMPLETED' };
    const reconciled = reconcileTaskStatus(task);
    assert.equal(reconciled.status, 'COMPLETED');
    assert.ok(reconciled.completed, 'completed ISO timestamp must be set');
    assert.equal(reconciled.percentComplete, 100);
  });

  await t.test('reconcileTaskStatus: completes task when percentComplete is 100', () => {
    const task = { title: 'Test', percentComplete: 100 };
    const reconciled = reconcileTaskStatus(task);
    assert.equal(reconciled.status, 'COMPLETED');
    assert.ok(reconciled.completed, 'completed ISO timestamp must be set');
    assert.equal(reconciled.percentComplete, 100);
  });

  await t.test('reconcileTaskStatus: reopens task when status is set to NEEDS-ACTION on previously completed object', () => {
    const prevCompletedTask = {
      title: 'Test',
      status: 'NEEDS-ACTION',
      completed: '2026-08-31T12:00:00.000Z',
      percentComplete: 100
    };
    const reconciled = reconcileTaskStatus(prevCompletedTask);
    assert.equal(reconciled.status, 'NEEDS-ACTION');
    assert.equal(reconciled.completed, null, 'completed date must be cleared to null');
    assert.equal(reconciled.percentComplete, 0, 'percentComplete must reset to 0');
  });

  await t.test('reconcileTaskStatus: reopens task when status is IN-PROCESS', () => {
    const prevCompletedTask = {
      title: 'Test',
      status: 'IN-PROCESS',
      completed: '2026-08-31T12:00:00.000Z',
      percentComplete: 100
    };
    const reconciled = reconcileTaskStatus(prevCompletedTask);
    assert.equal(reconciled.status, 'IN-PROCESS');
    assert.equal(reconciled.completed, null, 'completed date must be cleared to null');
    assert.equal(reconciled.percentComplete, 50, 'percentComplete must reset to 50 for IN-PROCESS');
  });

  await t.test('reconcileTaskStatus: reopens task when completed is explicitly set to null with NEEDS-ACTION status', () => {
    const task = {
      title: 'Test',
      status: 'NEEDS-ACTION',
      completed: null,
      percentComplete: 100
    };
    const reconciled = reconcileTaskStatus(task);
    assert.equal(reconciled.status, 'NEEDS-ACTION');
    assert.equal(reconciled.completed, null);
    assert.equal(reconciled.percentComplete, 0);
  });

  await t.test('reconcileTaskStatus: resets status if percentComplete is set to less than 100', () => {
    const task = {
      title: 'Test',
      status: 'COMPLETED',
      completed: '2026-08-31T12:00:00.000Z',
      percentComplete: 50
    };
    const reconciled = reconcileTaskStatus(task);
    assert.equal(reconciled.status, 'IN-PROCESS');
    assert.equal(reconciled.completed, null);
    assert.equal(reconciled.percentComplete, 50);
  });

  await t.test('parseICSToTask: reconciles inconsistent status and completed timestamp in raw ICS', () => {
    const rawIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:test-inconsistent-vtodo',
      'SUMMARY:Inconsistent Task',
      'STATUS:NEEDS-ACTION',
      'COMPLETED:20260831T120000Z',
      'PERCENT-COMPLETE:100',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const task = parseICSToTask(rawIcs);
    assert.equal(task.status, 'NEEDS-ACTION');
    assert.equal(task.completed, null, 'COMPLETED timestamp must be reconciled to null when STATUS is NEEDS-ACTION');
    assert.equal(task.percentComplete, 0, 'percentComplete must be reconciled to 0');
  });

  await t.test('taskToICS: removes COMPLETED line and updates PERCENT-COMPLETE when updating an existing completed ICS to NEEDS-ACTION', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:test-task-123',
      'SUMMARY:Buy Groceries',
      'STATUS:COMPLETED',
      'COMPLETED:20260831T120000Z',
      'PERCENT-COMPLETE:100',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const reopenedTask = {
      uid: 'test-task-123',
      title: 'Buy Groceries',
      status: 'NEEDS-ACTION'
    };

    const newIcs = taskToICS(reopenedTask, existingIcs);
    assert.ok(newIcs.includes('STATUS:NEEDS-ACTION'), 'ICS must reflect STATUS:NEEDS-ACTION');
    assert.ok(!newIcs.includes('COMPLETED:'), 'COMPLETED line must be removed from ICS');
    assert.ok(newIcs.includes('PERCENT-COMPLETE:0'), 'PERCENT-COMPLETE must be updated to 0');
  });

  await t.test('taskToICS: adds COMPLETED line and sets PERCENT-COMPLETE:100 when marking task COMPLETED', () => {
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:test-task-456',
      'SUMMARY:Clean Desk',
      'STATUS:NEEDS-ACTION',
      'PERCENT-COMPLETE:0',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n');

    const completedTask = {
      uid: 'test-task-456',
      title: 'Clean Desk',
      status: 'COMPLETED'
    };

    const newIcs = taskToICS(completedTask, existingIcs);
    assert.ok(newIcs.includes('STATUS:COMPLETED'), 'ICS must reflect STATUS:COMPLETED');
    assert.ok(newIcs.includes('COMPLETED:'), 'COMPLETED line must be added to ICS');
    assert.ok(newIcs.includes('PERCENT-COMPLETE:100'), 'PERCENT-COMPLETE must be updated to 100');
  });

});
