'use strict';

// Unit tests for the pure (DOM-free) helpers in lib/fillkit.js. The DOM-driving helpers
// (realClick, selectDropdown, …) need a live page and are exercised by live smoke tests;
// matchOption is the option-picking core that every platform's dropdown fill depends on,
// so it's the one worth locking down here.

const test = require('node:test');
const assert = require('node:assert');
const { matchOption, norm } = require('./fillkit.js');

const opts = (...txts) => txts.map((txt) => ({ el: txt, txt })); // el is irrelevant to matching

test('norm lowercases and trims, tolerates nullish', () => {
  assert.equal(norm('  Petrol '), 'petrol');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(2024), '2024');
});

test('matchOption: exact match wins over looser tiers', () => {
  const o = opts('Petrol', 'Petrol (E10)');
  assert.equal(matchOption(o, 'Petrol').txt, 'Petrol');
});

test('matchOption: case/whitespace-insensitive', () => {
  assert.equal(matchOption(opts('Diesel'), ' diesel ').txt, 'Diesel');
});

test('matchOption: startsWith tier', () => {
  // no exact "Automatic"; option starts with the value
  assert.equal(matchOption(opts('Automatic transmission'), 'Automatic').txt, 'Automatic transmission');
});

test('matchOption: value starts with a (>2 char) option', () => {
  // "2024 Camry" starts with the option "2024"
  assert.equal(matchOption(opts('2024'), '2024 Camry').txt, '2024');
});

test('matchOption: includes tier for values longer than 2 chars', () => {
  assert.equal(matchOption(opts('Ford Motor Company'), 'Ford').txt, 'Ford Motor Company');
});

test('matchOption: no false match for short (<=2) values via includes', () => {
  // "GT" should not match "Category" via includes because value length is not > 2... it is 2.
  assert.equal(matchOption(opts('Category'), 'gt'), undefined);
});

test('matchOption: empty/blank value returns null, no match returns undefined', () => {
  assert.equal(matchOption(opts('Red', 'Blue'), ''), null);
  assert.equal(matchOption(opts('Red', 'Blue'), '   '), null);
  assert.equal(matchOption(opts('Red', 'Blue'), 'Green'), undefined);
});
