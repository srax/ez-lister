import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityChangeKind } from './capacity-billing.js';

test('capacityChangeKind compares requested capacity with effective access', () => {
  assert.equal(capacityChangeKind(2, 3), 'increase');
  assert.equal(capacityChangeKind(2, 1), 'reduction');
  assert.equal(capacityChangeKind(2, 2), 'cancel_reduction');
});
