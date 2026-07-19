import test from 'node:test';
import assert from 'node:assert/strict';
import { availableCapacity, hashToken, normalizeEmail } from './organizations.js';

test('availableCapacity includes rooftop extras and subtracts live assignments and reservations', () => {
  assert.equal(availableCapacity({ includedSeats: 10, extraSeats: 2, assigned: 7, reserved: 3 }), 2);
  assert.equal(availableCapacity({ includedSeats: 10, extraSeats: 0, assigned: 11, reserved: 0 }), 0);
});

test('invitation helpers normalize email and hash tokens deterministically without storing raw values', () => {
  assert.equal(normalizeEmail('  Sales.Person@Example.COM '), 'sales.person@example.com');
  assert.equal(hashToken('secret'), hashToken('secret'));
  assert.notEqual(hashToken('secret'), 'secret');
});
