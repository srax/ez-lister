'use strict';

// Unit tests for the Facebook value taxonomy (mappers.fb.js). Fixture strings captured
// from the live Alexandria Toyota (DealerOn) probe on 2026-07-03.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mappers.fb.js');

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
