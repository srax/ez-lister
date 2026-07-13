'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  outcomeOf, hasOutcome, needsAction, isActiveLive, dealerCounts, sortForList, needsActionCount, isOutcome
} = require('./dealerOutcome.js');

const row = (over) => ({ key: 'K', status: 'active', listedAt: '2026-01-01T00:00:00Z', ...over });

test('isOutcome / outcomeOf: only the three valid outcomes count', () => {
  assert.equal(isOutcome('fb'), true);
  assert.equal(isOutcome('craigslist'), true);
  assert.equal(isOutcome('delisted'), true);
  assert.equal(isOutcome('offerup'), false);
  assert.equal(outcomeOf(row({ dealerOutcome: 'fb' })), 'fb');
  assert.equal(outcomeOf(row({ dealerOutcome: 'bogus' })), null);
  assert.equal(outcomeOf(row()), null);
});

test('needsAction: gone + unclassified + not personally sold', () => {
  assert.equal(needsAction(row({ inventoryGone: true })), true);
  assert.equal(needsAction(row({ inventoryGone: false })), false);         // still on the lot
  assert.equal(needsAction(row({})), false);                               // no signal
});

test('needsAction: a personally-sold car is exempt (user already knows)', () => {
  assert.equal(needsAction(row({ inventoryGone: true, status: 'sold' })), false);
});

test('needsAction: once classified, no longer needs action', () => {
  assert.equal(needsAction(row({ inventoryGone: true, dealerOutcome: 'fb' })), false);
  assert.equal(needsAction(row({ inventoryGone: true, dealerOutcome: 'delisted' })), false);
});

test('isActiveLive: outcome cars (sold-by-dealer AND delisted) drop out of Active', () => {
  assert.equal(isActiveLive(row()), true);
  assert.equal(isActiveLive(row({ dealerOutcome: 'fb' })), false);
  assert.equal(isActiveLive(row({ dealerOutcome: 'delisted' })), false);
  assert.equal(isActiveLive(row({ status: 'sold' })), false);              // personal sold isn't live either
});

test('dealerCounts: one bucket per outcome; delisted is not a sale', () => {
  const rows = [
    row({ key: 'a', dealerOutcome: 'fb' }),
    row({ key: 'b', dealerOutcome: 'fb' }),
    row({ key: 'c', dealerOutcome: 'craigslist' }),
    row({ key: 'd', dealerOutcome: 'delisted' }),
    row({ key: 'e' }),                       // untouched active — ignored
    row({ key: 'f', status: 'sold' })        // personal sold — ignored (not a dealership outcome)
  ];
  const c = dealerCounts(rows);
  assert.deepEqual(c, { fb: 2, craigslist: 1, delisted: 1, sold: 3, total: 4 });
});

test('sortForList: needs-action floats to the top, then newest-first', () => {
  const rows = [
    row({ key: 'old', listedAt: '2026-01-01T00:00:00Z' }),
    row({ key: 'new', listedAt: '2026-06-01T00:00:00Z' }),
    row({ key: 'needs', listedAt: '2020-01-01T00:00:00Z', inventoryGone: true })
  ];
  const order = sortForList(rows).map((r) => r.key);
  assert.deepEqual(order, ['needs', 'new', 'old']);
});

test('needsActionCount: drives the red-orange dot', () => {
  const rows = [
    row({ key: 'a', inventoryGone: true }),
    row({ key: 'b', inventoryGone: true, dealerOutcome: 'fb' }), // handled
    row({ key: 'c', inventoryGone: true, status: 'sold' }),      // exempt
    row({ key: 'd' })
  ];
  assert.equal(needsActionCount(rows), 1);
  assert.equal(hasOutcome(rows[1]), true);
});
