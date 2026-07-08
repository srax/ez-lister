'use strict';

// Unit tests for the shared, platform-agnostic core decoders. Fixture strings captured
// from the live Alexandria Toyota (DealerOn) probe on 2026-07-03.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mappers.core.js');

// ---- cleanAttr: dealer feeds inject raw HTML into color attributes ----
test('cleanAttr strips injected disclaimer HTML and collapses whitespace', () => {
  assert.equal(
    M.cleanAttr("Wind Chill Pearl <a role='button' class='viewDgDisclaimersButton'><sup>17</sup></a>"),
    'Wind Chill Pearl'
  );
  assert.equal(M.cleanAttr('  Celestite  '), 'Celestite');
  assert.equal(M.cleanAttr(null), '');
  assert.equal(M.cleanAttr(undefined), '');
});

// ---- decodePriceLib: labelled parse, never the max ----
test('decodePriceLib prefers Selling Price over fee-inflated calc_ rows', () => {
  // live card: advertised $7,495; the old max-of-numbers logic returned 8,490
  const b64 = btoa('Internet Price:7495.0;Selling Price:7495.0;reff_Flat Low Price:7495.0;calc_INTERNET PRICE:8490.0');
  assert.equal(M.decodePriceLib(b64), 7495);
});

test('decodePriceLib: doc-fee-only payload yields undefined (caller falls back)', () => {
  assert.equal(M.decodePriceLib(btoa('calc_INTERNET PRICE:995.0')), undefined);
});

test('decodePriceLib: new-car payload with full label set', () => {
  const b64 = btoa('Internet Price:25749.00;Selling Price:25749.00;Invoice Price:23362.36;MSRP:24754.00;Conditional:1250.0;calc_MSRP:24754.00;calc_MSRP + TDSP:24754.0;calc_INTERNET PRICE:26744.00;calc_Discount Adv Price:25749.0;dealerfee:995.0');
  assert.equal(M.decodePriceLib(b64), 25749);
});

test('decodePriceLib: MSRP is the last-resort label', () => {
  assert.equal(M.decodePriceLib(btoa('MSRP:24754.00;dealerfee:995.0')), 24754);
});

test('decodePriceLib: garbage input is undefined, never throws', () => {
  assert.equal(M.decodePriceLib(''), undefined);
  assert.equal(M.decodePriceLib('%%%not-base64%%%'), undefined);
  assert.equal(M.decodePriceLib(btoa('no numbers here')), undefined);
});

test('plausiblePrice: bounds', () => {
  assert.equal(M.plausiblePrice(7495), true);
  assert.equal(M.plausiblePrice(999), false);
  assert.equal(M.plausiblePrice(500001), false);
  assert.equal(M.plausiblePrice('7495'), false); // must be a number
});
