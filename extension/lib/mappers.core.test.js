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

// ---- composeDescription: the ONE template (panel preview ≡ auto-fill output, details ALWAYS in) ----
const EQUINOX = {
  year: 2027, make: 'Chevrolet', model: 'Equinox AWD LT', mileage: 2,
  vin: '3GNAXPEGXVL103457', stock: 'B27100061',
  exteriorColor: 'Sterling Gray Metallic', interiorColor: 'Black, Cloth seat trim',
  engine: '1.5L i-4', fuelType: 'Gasoline Fuel',
  sourceUrl: 'https://www.burdickgm.com/new/Chevrolet/2027-Chevrolet-Equinox-fad7a046ac1823d859b5afae73c13957.htm'
};

const FULL_EQUINOX = (head) => [
  head,
  '• Mileage: 2 miles',
  '• VIN: 3GNAXPEGXVL103457',
  '• Stock #: B27100061',
  '• Exterior: Sterling Gray Metallic',
  '• Interior: Black, Cloth seat trim',
  '• Engine: 1.5L i-4',
  '• Fuel: Gasoline Fuel',
  '',
  'Message us to schedule a test drive!',
  EQUINOX.sourceUrl
].join('\n');

test('composeDescription: default prefs → the full detailed version', () => {
  assert.equal(M.composeDescription(EQUINOX, {}), FULL_EQUINOX('2027 Chevrolet Equinox AWD LT'));
});

test('composeDescription: emoji pref applies, details stay in', () => {
  assert.equal(M.composeDescription(EQUINOX, { emoji: '🚗' }), FULL_EQUINOX('🚗 2027 Chevrolet Equinox AWD LT'));
});

test('composeDescription: an old stored dealerDesc:false pref can NO LONGER trim the details', () => {
  const out = M.composeDescription(EQUINOX, { emoji: '🚗', dealerDesc: false, mileage: true, unit: 'mi' });
  assert.ok(out.includes('• VIN: 3GNAXPEGXVL103457'), 'VIN must be present');
  assert.ok(out.includes('• Stock #: B27100061'), 'stock must be present');
  assert.ok(out.includes('• Engine: 1.5L i-4'), 'engine must be present');
});

test('composeDescription: km unit + "Add mileage" toggle off', () => {
  assert.ok(M.composeDescription(EQUINOX, { unit: 'km' }).includes('• Mileage: 3 km'));
  assert.ok(!M.composeDescription(EQUINOX, { mileage: false }).includes('Mileage'));
});

test('composeDescription: deterministic (panel ≡ fill) and null-safe', () => {
  const prefs = { emoji: '⚡', unit: 'mi', mileage: true };
  assert.equal(M.composeDescription(EQUINOX, prefs), M.composeDescription({ ...EQUINOX }, { ...prefs }));
  assert.equal(M.composeDescription(null, {}), '');
});

test('formatDistance: miles wording matches the posted description', () => {
  assert.equal(M.formatDistance(146787, 'mi'), '146,787 miles');
  assert.equal(M.formatDistance(146787, 'km'), '236,230 km');
});
