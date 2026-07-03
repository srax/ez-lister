'use strict';

// Unit tests for the shared content-script mappers. Every fixture string below was
// captured from the live Alexandria Toyota (DealerOn) probe on 2026-07-03.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mappers.js');

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

// ---- mapColor ----
test('mapColor: exact FB palette names', () => {
  assert.equal(M.mapColor('Black'), 'Black');
  assert.equal(M.mapColor('grey'), 'Grey');
});

test('mapColor: marketing names via keywords (live examples)', () => {
  assert.equal(M.mapColor('Celestite'), 'Blue');
  assert.equal(M.mapColor('Geranium Red'), 'Red');
  assert.equal(M.mapColor('Pearl White'), 'White');
  assert.equal(M.mapColor('Liquid Silver Metallic'), 'Silver');
  assert.equal(M.mapColor('Red Hot'), 'Red');
  assert.equal(M.mapColor('Jet Black'), 'Black');
  assert.equal(M.mapColor('Crystal White Pearl Mica'), 'White');
  assert.equal(M.mapColor('Magnetic Gray Metallic'), 'Grey');
});

test('mapColor: two-tone takes the first colour', () => {
  assert.equal(M.mapColor('Black/Blue'), 'Black');
});

test('mapColor: upholstery material words are stripped, paint finishes kept', () => {
  assert.equal(M.mapColor('Light Gray Fabric'), 'Grey');
  assert.equal(M.mapColor('Black Leatherette'), 'Black');
  assert.equal(M.mapColor('Black SofTex'), 'Black');
  assert.equal(M.mapColor('Wind Chill Pearl'), 'White'); // "Pearl" must survive stripping
  assert.equal(M.mapColor('Leather'), '');               // material-only -> blank, not a guess
});

test('mapColor: HTML-polluted attr still maps (sanitize before match)', () => {
  assert.equal(M.mapColor("Wind Chill Pearl <a role='button'><sup>17</sup></a>"), 'White');
});

test("mapColor: generic bucket values — 'Gray' maps, 'Other' stays blank", () => {
  assert.equal(M.mapColor('Gray'), 'Grey');
  assert.equal(M.mapColor('Other'), '');
});

test('mapColor: unknown marketing name -> blank for manual review', () => {
  assert.equal(M.mapColor('Solar Octane'), ''); // /tan/ once matched "ocTANe" -> Tan
  assert.equal(M.mapColor(''), '');
  assert.equal(M.mapColor(null), '');
});

test('mapColor: word-boundary guards do not break real uses of short tokens', () => {
  assert.equal(M.mapColor('Ash Gray'), 'Grey');
  assert.equal(M.mapColor('Tan'), 'Tan');
  assert.equal(M.mapColor('Sky Blue'), 'Blue');
  assert.equal(M.mapColor('Flash Red'), 'Red'); // /ash/ once matched "flASH" -> Grey
});

// ---- mapBody / mapFuel / mapTransmission (live attr values) ----
test('mapBody: dotagging body types and dealer styles', () => {
  assert.equal(M.mapBody('SUV'), '4x4');
  assert.equal(M.mapBody('Sport Utility'), '4x4');
  assert.equal(M.mapBody('Sedan'), 'Saloon');
  assert.equal(M.mapBody('4dr Car'), '');   // ambiguous -> blank (dotagging attr wins upstream)
});

test('mapFuel: live feed values', () => {
  assert.equal(M.mapFuel('Gasoline Fuel'), 'Petrol');
  assert.equal(M.mapFuel('Hybrid Fuel'), 'Hybrid');
  assert.equal(M.mapFuel('Gas'), 'Petrol');
  assert.equal(M.mapFuel('Plug-In Hybrid'), 'Plug-in hybrid');
});

test('mapTransmission: only /manual/ maps to Manual', () => {
  assert.equal(M.mapTransmission('Variable'), 'Automatic transmission');
  assert.equal(M.mapTransmission('Dynamic Shift Continuously Variable Transmission (CVT)'), 'Automatic transmission');
  assert.equal(M.mapTransmission('6-Speed Manual'), 'Manual transmission');
  assert.equal(M.mapTransmission(''), 'Automatic transmission');
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
