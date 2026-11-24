import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortName } from '../lib/service.js';

test('shortName uses first name and skips a leading initial', () => {
  assert.equal(shortName({ name: 'J Tyler Ray' }), 'Tyler');
  assert.equal(shortName({ name: 'Kaila Pidwerbeski' }), 'Kaila');
  assert.equal(shortName({ name: 'Kad A' }), 'Kad');
  assert.equal(shortName({ firstName: 'Sandy', name: 'Sandy Kim' }), 'Sandy');
  assert.equal(shortName({ name: 'Khaled' }), 'Khaled');
  assert.equal(shortName({}), '');
});
