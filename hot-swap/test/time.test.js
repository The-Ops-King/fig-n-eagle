import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, dateKey, nextDateKey, hourStart, hourLabel, weekdayOf } from '../lib/time.js';

const ET = 'America/New_York';

test('zonedToUtc handles EST and EDT', () => {
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 11, day: 25, hour: 8 }, ET)).toISOString(), '2026-11-25T13:00:00.000Z');
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 8 }, ET)).toISOString(), '2026-07-01T12:00:00.000Z');
});

test('hourStart across the DST change day (Nov 1 2026)', () => {
  assert.equal(new Date(hourStart('2026-11-01', 0, ET)).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(new Date(hourStart('2026-11-01', 8, ET)).toISOString(), '2026-11-01T13:00:00.000Z');
});

test('dateKey uses the local date, not UTC', () => {
  assert.equal(dateKey(Date.parse('2026-11-25T03:00:00Z'), ET), '2026-11-24');
});

test('nextDateKey rolls months and years', () => {
  assert.equal(nextDateKey('2026-11-30'), '2026-12-01');
  assert.equal(nextDateKey('2026-12-31'), '2027-01-01');
});

test('labels and weekdays', () => {
  assert.equal(hourLabel(0), '12 AM');
  assert.equal(hourLabel(12), '12 PM');
  assert.equal(hourLabel(20), '8 PM');
  assert.equal(weekdayOf('2026-11-25'), 3);
});
