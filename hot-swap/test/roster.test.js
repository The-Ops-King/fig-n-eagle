import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoster, pickReplacement } from '../lib/roster.js';

const person = (id, free, load = 0) => ({ id, name: id, free: new Set(free), load });

test('fills headcount and reports gaps', () => {
  const r = planRoster({
    hours: [8, 9, 10],
    people: [person('a', [8, 9]), person('b', [9])],
    headcount: (h) => (h === 9 ? 2 : 1),
  });
  assert.deepEqual(r.assignments.get(8), ['a']);
  assert.deepEqual(r.assignments.get(9).sort(), ['a', 'b']);
  assert.deepEqual(r.assignments.get(10), []);
  assert.deepEqual(r.gaps, [{ hour: 10, missing: 1 }]);
});

test('respects max consecutive hours', () => {
  const r = planRoster({
    hours: [8, 9, 10, 11],
    people: [person('a', [8, 9, 10, 11]), person('b', [8, 9, 10, 11], 5)],
    headcount: () => 1,
    maxConsecutive: 2,
  });
  const seq = [8, 9, 10, 11].map((h) => r.assignments.get(h)[0]);
  assert.deepEqual(seq, ['a', 'a', 'b', 'b']);
});

test('spreads load: lighter day wins a tie', () => {
  const r = planRoster({ hours: [8], people: [person('busy', [8], 6), person('light', [8], 1)], headcount: () => 1 });
  assert.deepEqual(r.assignments.get(8), ['light']);
});

test('locked assignments are kept and count toward headcount', () => {
  const r = planRoster({
    hours: [8],
    people: [person('a', [8]), person('b', [])],
    headcount: () => 2,
    locked: new Map([[8, ['b']]]),
  });
  assert.deepEqual(r.assignments.get(8), ['b', 'a']);
  assert.deepEqual(r.gaps, []);
});

test('never assigns someone who is not free', () => {
  const r = planRoster({ hours: [8], people: [person('a', [9])], headcount: () => 1 });
  assert.deepEqual(r.assignments.get(8), []);
});

test('pickReplacement excludes the person dropping out', () => {
  const p = pickReplacement({ hour: 8, people: [person('a', [8]), person('b', [8], 3)], exclude: ['a'] });
  assert.equal(p.id, 'b');
  assert.equal(pickReplacement({ hour: 8, people: [person('a', [9])] }), null);
});
