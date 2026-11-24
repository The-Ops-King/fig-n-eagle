import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestClient, resetTestData } from '../lib/service.js';
import { loadConfig } from '../lib/config.js';

test('reset only allowed for -test clients', async () => {
  assert.equal(isTestClient(loadConfig('fig-n-eagle-test')), true);
  assert.equal(isTestClient(loadConfig('fig-n-eagle')), false);
  await assert.rejects(resetTestData(loadConfig('fig-n-eagle'), { ghl: {}, slack: {}, team: { people: [] } }), /Refusing to reset/);
});
