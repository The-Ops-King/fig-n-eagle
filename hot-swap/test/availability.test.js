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
  assert.deepEqual(freeHours(iv, [t(13), t(14), t(15)]), [t(13), t(14)]); // last slot only 45 min
});

test('a gap breaks coverage', () => {
  const iv = slotsToIntervals([t(9), t(9, 30), t(11)], 45, 30);
  assert.deepEqual(freeHours(iv, [t(9), t(10), t(11)]), [t(9)]);
});

test('no slots, no free hours', () => {
  assert.deepEqual(freeHours(slotsToIntervals([], 45, 30), [t(9)]), []);
});
