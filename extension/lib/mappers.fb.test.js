'use strict';

// Unit tests for the Facebook value taxonomy (mappers.fb.js). Fixture strings captured
// from the live Alexandria Toyota (DealerOn) probe on 2026-07-03.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mappers.fb.js');

// ---- mapColor ----
test('mapColor: exact FB palette names', () => {
  assert.equal(M.mapColor('Black'), 'Black');
  assert.equal(M.mapColor('grey'), 'Gray');
});

test('mapColor: marketing names via keywords (live examples)', () => {
  assert.equal(M.mapColor('Celestite'), 'Blue');
  assert.equal(M.mapColor('Geranium Red'), 'Red');
  assert.equal(M.mapColor('Pearl White'), 'White');
  assert.equal(M.mapColor('Liquid Silver Metallic'), 'Silver');
  assert.equal(M.mapColor('Red Hot'), 'Red');
  assert.equal(M.mapColor('Jet Black'), 'Black');
  assert.equal(M.mapColor('Crystal White Pearl Mica'), 'White');
  assert.equal(M.mapColor('Magnetic Gray Metallic'), 'Gray');
});

test('mapColor: two-tone takes the first colour', () => {
  assert.equal(M.mapColor('Black/Blue'), 'Black');
});

test('mapColor: upholstery material words are stripped, paint finishes kept', () => {
  assert.equal(M.mapColor('Light Gray Fabric'), 'Gray');
  assert.equal(M.mapColor('Black Leatherette'), 'Black');
  assert.equal(M.mapColor('Black SofTex'), 'Black');
  assert.equal(M.mapColor('Wind Chill Pearl'), 'White'); // "Pearl" must survive stripping
  assert.equal(M.mapColor('Leather'), '');               // material-only -> blank, not a guess
});

test('mapColor: HTML-polluted attr still maps (sanitize before match)', () => {
  assert.equal(M.mapColor("Wind Chill Pearl <a role='button'><sup>17</sup></a>"), 'White');
});

test("mapColor: generic bucket values — 'Gray' maps, 'Other' stays blank", () => {
  assert.equal(M.mapColor('Gray'), 'Gray');
  assert.equal(M.mapColor('Other'), '');
});

test('mapColor: unknown marketing name -> blank for manual review', () => {
  assert.equal(M.mapColor('Solar Octane'), ''); // /tan/ once matched "ocTANe" -> Tan
  assert.equal(M.mapColor(''), '');
  assert.equal(M.mapColor(null), '');
});

test('mapColor: word-boundary guards do not break real uses of short tokens', () => {
  assert.equal(M.mapColor('Ash Gray'), 'Gray');
  assert.equal(M.mapColor('Tan'), 'Tan');
  assert.equal(M.mapColor('Sky Blue'), 'Blue');
  assert.equal(M.mapColor('Flash Red'), 'Red'); // /ash/ once matched "flASH" -> Grey
});

// ---- mapBody / mapFuel / mapTransmission (live attr values) ----
test('mapBody: dotagging body types and dealer styles', () => {
  assert.equal(M.mapBody('SUV'), 'SUV');
  assert.equal(M.mapBody('Sport Utility'), 'SUV');
  assert.equal(M.mapBody('Sedan'), 'Sedan');
  assert.equal(M.mapBody('4dr Car'), '');   // ambiguous -> blank (dotagging attr wins upstream)
});

test('mapFuel: live feed values', () => {
  assert.equal(M.mapFuel('Gasoline Fuel'), 'Gasoline');
  assert.equal(M.mapFuel('Hybrid Fuel'), 'Hybrid');
  assert.equal(M.mapFuel('Gas'), 'Gasoline');
  assert.equal(M.mapFuel('Plug-In Hybrid'), 'Plug-in hybrid');
});

test('mapTransmission: only /manual/ maps to Manual', () => {
  assert.equal(M.mapTransmission('Variable'), 'Automatic transmission');
  assert.equal(M.mapTransmission('Dynamic Shift Continuously Variable Transmission (CVT)'), 'Automatic transmission');
  assert.equal(M.mapTransmission('6-Speed Manual'), 'Manual transmission');
  assert.equal(M.mapTransmission(''), 'Automatic transmission');
});

// ---- optionCandidates: US canonical first, UK composer spelling as fallback ----
test('optionCandidates: locale-different values get the UK fallback second', () => {
  assert.deepEqual(M.optionCandidates('Car/Truck'), ['Car/Truck', 'Car/van']);
  assert.deepEqual(M.optionCandidates('Car/van'), ['Car/Truck', 'Car/van']);
  assert.deepEqual(M.optionCandidates('SUV'), ['SUV', '4x4']);
  assert.deepEqual(M.optionCandidates('Truck'), ['Truck', '4x4']);
  assert.deepEqual(M.optionCandidates('Sedan'), ['Sedan', 'Saloon']);
  assert.deepEqual(M.optionCandidates('Gasoline'), ['Gasoline', 'Petrol']);
  assert.deepEqual(M.optionCandidates('Gray'), ['Gray', 'Grey']);
  assert.deepEqual(M.optionCandidates('Wagon'), ['Wagon', 'Estate']);
  assert.deepEqual(M.optionCandidates('Minivan'), ['Minivan', 'MPV/People carrier']);
});

test('optionCandidates: locale-identical values pass through; empty stays empty', () => {
  assert.deepEqual(M.optionCandidates('Hybrid'), ['Hybrid']);
  assert.deepEqual(M.optionCandidates('Automatic transmission'), ['Automatic transmission']);
  assert.deepEqual(M.optionCandidates('Excellent'), ['Excellent']);
  assert.deepEqual(M.optionCandidates(''), []);
  assert.deepEqual(M.optionCandidates(null), []);
});
// (decodePriceLib tests live in mappers.core.test.js — that's where the function moved.)
