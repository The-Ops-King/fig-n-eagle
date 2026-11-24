import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotsToIntervals, freeHours } from '../lib/availability.js';

const M = 60_000, H = 60 * M;
const t = (h, m = 0) => h * H + m * M;

test('45-min slots every 30 min cover the whole hour', () => {
  const iv = slotsToIntervals([t(9), t(9, 30), t(10), t(10, 30)], 45, 30);
  assert.deepEqual(freeHours(iv, [t(9), t(10)]), [t(9), t(10)]);
});

test('45-min slots every 60 min are continuous when consecutive', () => {
  const iv = slotsToIntervals([t(13), t(14), t(15)], 45, 60);
  assert.deepEqual(freeHours(iv, [t(13), t(14), t(15)], 60), [t(13), t(14)]); // full hour: last slot too short
  assert.deepEqual(freeHours(iv, [t(13), t(14), t(15)]), [t(13), t(14), t(15)]); // default 45: last hour counts
});

test('last hour of the day counts with the default 45-minute rule', () => {
  const iv = slotsToIntervals([t(19), t(19, 30), t(20)], 45, 30);
  assert.deepEqual(freeHours(iv, [t(19), t(20)]), [t(19), t(20)]);
});

test('a gap breaks coverage', () => {
  const iv = slotsToIntervals([t(9), t(9, 30), t(11)], 45, 30);
  assert.deepEqual(freeHours(iv, [t(9), t(10), t(11)]), [t(9), t(11)]); // 10:00-10:45 not free (10:15 busy)
});

test('no slots, no free hours', () => {
  assert.deepEqual(freeHours(slotsToIntervals([], 45, 30), [t(9)]), []);
});

test('hour already under way: checks from the next slot to the end of the hour', () => {
  // 9:13 now; GHL only returns 9:30 onward
  const iv = slotsToIntervals([t(9, 30), t(10), t(10, 30)], 45, 30);
  assert.deepEqual(freeHours(iv, [t(9), t(10)], 45, { now: t(9, 13), stepMinutes: 30 }), [t(9), t(10)]);
  // busy from 9:30: current hour not coverable
  const busy = slotsToIntervals([t(10), t(10, 30)], 45, 30);
  assert.deepEqual(freeHours(busy, [t(9), t(10)], 45, { now: t(9, 13), stepMinutes: 30 }), [t(10)]);
  // 9:45 now, next boundary 10:00 = end of hour: too late to cover 9 AM
  assert.deepEqual(freeHours(iv, [t(9)], 45, { now: t(9, 45), stepMinutes: 30 }), []);
});
