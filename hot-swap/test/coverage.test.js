import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, dayCoverage } from '../lib/config.js';

const cfg = loadConfig('fig-n-eagle');
const all = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

test('default: config hours', () => {
  assert.deepEqual(dayCoverage(cfg, '2026-11-25', [], 3).hours, all);
});

test('weekday rule applies to that weekday', () => {
  const rules = [{ kind: 'weekday', key: '6', mode: 'hours', first_hour: 10, last_hour: 15 }];
  assert.deepEqual(dayCoverage(cfg, '2026-11-28', rules, 6).hours, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(dayCoverage(cfg, '2026-11-27', rules, 5).hours, all);
});

test('date rule beats weekday rule; off means no hours', () => {
  const rules = [
    { kind: 'weekday', key: '4', mode: 'hours', first_hour: 9, last_hour: 12 },
    { kind: 'date', key: '2026-11-26', mode: 'off' },
  ];
  assert.deepEqual(dayCoverage(cfg, '2026-11-26', rules, 4), { hours: [], source: 'date', rule: rules[1] });
  assert.deepEqual(dayCoverage(cfg, '2026-12-03', rules, 4).hours, [9, 10, 11, 12]);
});
