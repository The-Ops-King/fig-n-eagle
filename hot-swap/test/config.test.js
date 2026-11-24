import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, headcountFor, coverageHours } from '../lib/config.js';

test('fig-n-eagle config loads and is valid', () => {
  const cfg = loadConfig('fig-n-eagle');
  assert.equal(cfg.timezone, 'America/New_York');
  assert.deepEqual(coverageHours(cfg), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(headcountFor(cfg, 14), 2);
  assert.equal(headcountFor(cfg, 9), 1);
});

test('rejects path-like client names', () => {
  assert.throws(() => loadConfig('../etc'), /Invalid client/);
});
