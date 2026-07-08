'use strict';

// Unit tests for the Craigslist value taxonomy (mappers.craigslist.js). Every mapped output
// must be an exact CL <select> option label, or '' (user picks) — except condition/title,
// which carry a safe dealer default.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mappers.craigslist.js');

test('mapBody: common dealer body types -> CL labels', () => {
  assert.equal(M.mapBody('SUV'), 'SUV');
  assert.equal(M.mapBody('Sport Utility'), 'SUV');
  assert.equal(M.mapBody('Crossover'), 'SUV');
  assert.equal(M.mapBody('Sedan'), 'sedan');
  assert.equal(M.mapBody('Coupe'), 'coupe');
  assert.equal(M.mapBody('Wagon'), 'wagon');
  assert.equal(M.mapBody('Minivan'), 'minivan');
  assert.equal(M.mapBody('Pickup'), 'pickup');
  assert.equal(M.mapBody('4dr Car'), ''); // ambiguous -> blank
  assert.equal(M.mapBody(''), '');
});

test('mapFuel: live feed values -> CL labels', () => {
  assert.equal(M.mapFuel('Gasoline Fuel'), 'gas');
  assert.equal(M.mapFuel('Gas'), 'gas');
  assert.equal(M.mapFuel('Diesel'), 'diesel');
  assert.equal(M.mapFuel('Hybrid Fuel'), 'hybrid');
  assert.equal(M.mapFuel('Plug-In Hybrid'), 'hybrid'); // CL has no phev slot
  assert.equal(M.mapFuel('Electric'), 'electric');
  assert.equal(M.mapFuel('E85 Flex Fuel'), 'other');
  assert.equal(M.mapFuel(''), '');
});

test('mapTransmission: only /manual/ maps to manual, else automatic, blank stays blank', () => {
  assert.equal(M.mapTransmission('6-Speed Manual'), 'manual');
  assert.equal(M.mapTransmission('CVT'), 'automatic');
  assert.equal(M.mapTransmission('Variable'), 'automatic');
  assert.equal(M.mapTransmission(''), ''); // no data -> blank, don't assume
});

test('mapCondition: maps known, defaults to excellent (dealer default)', () => {
  assert.equal(M.mapCondition('Excellent'), 'excellent');
  assert.equal(M.mapCondition('Like New'), 'like new');
  assert.equal(M.mapCondition('Good'), 'good');
  assert.equal(M.mapCondition('Salvage'), 'salvage');
  assert.equal(M.mapCondition('Used'), 'excellent'); // dealer "used" -> excellent
  assert.equal(M.mapCondition(''), 'excellent');
  assert.equal(M.mapCondition('whatever'), 'excellent');
});

test('mapTitleStatus: maps known, defaults to clean (dealer default)', () => {
  assert.equal(M.mapTitleStatus('Clean'), 'clean');
  assert.equal(M.mapTitleStatus('Salvage'), 'salvage');
  assert.equal(M.mapTitleStatus('Rebuilt'), 'rebuilt');
  assert.equal(M.mapTitleStatus(''), 'clean');
  assert.equal(M.mapTitleStatus(undefined), 'clean');
});

test('mapColor: exact CL palette', () => {
  assert.equal(M.mapColor('Black'), 'black');
  assert.equal(M.mapColor('grey'), 'grey');
  assert.equal(M.mapColor('Silver'), 'silver');
});

test('mapColor: marketing names -> CL palette via keywords', () => {
  assert.equal(M.mapColor('Celestite'), 'blue');
  assert.equal(M.mapColor('Magnetic Gray Metallic'), 'grey');
  assert.equal(M.mapColor('Wind Chill Pearl'), 'white');
  assert.equal(M.mapColor('Liquid Silver Metallic'), 'silver');
  assert.equal(M.mapColor('Jet Black'), 'black');
});

test('mapColor: CL has no charcoal/burgundy/gold slot -> nearest or custom', () => {
  assert.equal(M.mapColor('Charcoal'), 'grey');   // no charcoal option
  assert.equal(M.mapColor('Burgundy'), 'red');    // dark red -> red
  assert.equal(M.mapColor('Champagne Gold'), 'custom');
  assert.equal(M.mapColor('Beige'), 'custom');
  assert.equal(M.mapColor('Tan'), 'custom');
});

test('mapColor: material stripping + two-tone first colour + unknown blank', () => {
  assert.equal(M.mapColor('Light Gray Fabric'), 'grey');
  assert.equal(M.mapColor('Black/Blue'), 'black');
  assert.equal(M.mapColor('Leather'), '');       // material only -> blank
  assert.equal(M.mapColor('Solar Octane'), '');  // unknown -> blank
  assert.equal(M.mapColor(''), '');
  assert.equal(M.mapColor(null), '');
});
