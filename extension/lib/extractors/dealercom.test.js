'use strict';

// Unit tests for the Dealer.com extractor's pure text parsers. Fixture strings captured from a
// live Dealer.com SRP (chevroletbuickgmcofattleboro, Cox Automotive) on 2026-07-10.

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./dealercom.js');

test('cleanVin: strips the "VIN" label and trailing space', () => {
  assert.equal(D.cleanVin('VIN KL4MMFSL6PB119924 '), 'KL4MMFSL6PB119924');
  assert.equal(D.cleanVin('VIN 1HTKHPVM4PH180684 '), '1HTKHPVM4PH180684');
  assert.equal(D.cleanVin('LRBFZNR42ND163282'), 'LRBFZNR42ND163282');
  assert.equal(D.cleanVin(''), '');
});

test('parseStockNumber: strips the "Stock #" label', () => {
  assert.equal(D.parseStockNumber('Stock # 23019B '), '23019B');
  assert.equal(D.parseStockNumber('Stock # 22024B'), '22024B');
});

test('stripColorSuffix: drops the trailing Exterior/Interior word', () => {
  assert.equal(D.stripColorSuffix('Black Metallic Exterior'), 'Black Metallic');
  assert.equal(D.stripColorSuffix('White Exterior'), 'White');
  assert.equal(D.stripColorSuffix('EBONY / EBONY ACCENTS Interior'), 'EBONY / EBONY ACCENTS');
});

test('parseMoney: dollar/comma text → integer, junk → undefined', () => {
  assert.equal(D.parseMoney('$25,585'), 25585);
  assert.equal(D.parseMoney('$698'), 698);
  assert.equal(D.parseMoney('$110,844'), 110844);
  assert.equal(D.parseMoney(''), undefined);
  assert.equal(D.parseMoney('No Price'), undefined);
});

test('parseTitleName: year off the front, make word(s) dropped, rest is the model', () => {
  assert.deepEqual(D.parseTitleName('2023 Buick Encore GX Essence', 'Buick'),
    { year: '2023', model: 'Encore GX Essence' });
  assert.deepEqual(D.parseTitleName('2023 Chevrolet Silverado Md Work Truck', 'Chevrolet'),
    { year: '2023', model: 'Silverado Md Work Truck' });
  // hyphenated make: URL gives "Mercedes Benz", title has the single token "Mercedes-Benz"
  assert.deepEqual(D.parseTitleName('2017 Mercedes-Benz GLE 350', 'Mercedes Benz'),
    { year: '2017', model: 'GLE 350' });
  // two-word make
  assert.deepEqual(D.parseTitleName('2020 Land Rover Range Rover Sport', 'Land Rover'),
    { year: '2020', model: 'Range Rover Sport' });
});

test('makeFromVdpPath / conditionFromVdpPath: read the path segments', () => {
  assert.equal(D.makeFromVdpPath('/used/Buick/2023-Buick-Encore-GX-688cd3bf.htm'), 'Buick');
  assert.equal(D.makeFromVdpPath('/new/Chevrolet/2023-Chevrolet-Silverado-Md-68968f7c.htm'), 'Chevrolet');
  assert.equal(D.makeFromVdpPath('/used/Mercedes-Benz/2017-x.htm'), 'Mercedes Benz');
  assert.equal(D.conditionFromVdpPath('/used/Buick/x.htm'), 'used');
  assert.equal(D.conditionFromVdpPath('/new/Chevrolet/x.htm'), 'new');
});

test('bodyFromTitle: trailing body word off the image title', () => {
  assert.equal(D.bodyFromTitle('2023 Buick Encore GX Essence SUV'), 'SUV');
  assert.equal(D.bodyFromTitle('2023 Chevrolet Silverado Md Work Truck Truck'), 'Truck');
  assert.equal(D.bodyFromTitle('2022 Buick Envision Essence'), ''); // no body word present
});

test('fuelFromBadges: picks a fuel word out of the highlight badges', () => {
  assert.equal(D.fuelFromBadges(['New', 'Diesel']), 'Diesel');
  assert.equal(D.fuelFromBadges(['Used', '25,541 miles']), '');
  assert.equal(D.fuelFromBadges([]), '');
});

test('normalizePhoto: collapse the resize query to a stable large render', () => {
  assert.equal(
    D.normalizePhoto('https://pictures.dealer.com/c/acct/1158/b3788316d5c443d71fe80f1581c3b440x.jpg?impolicy=downsize_bkpt&imdensity=1&w=520'),
    'https://pictures.dealer.com/c/acct/1158/b3788316d5c443d71fe80f1581c3b440x.jpg?impolicy=downsize_bkpt&w=1200');
});

test('extractPhotoUrlsFromHtml: pulls unique gallery images from raw VDP HTML', () => {
  const html = `
    <img src="https://pictures.dealer.com/c/acct/1158/aaa111x.jpg?w=520">
    <img src="https://pictures.dealer.com/c/acct/0484/bbb222x.jpg?w=800">
    <img src="https://pictures.dealer.com/c/acct/1158/aaa111x.jpg?w=1200">
    <img src="https://images.dealer.com/graphics/logo.png">`;
  const urls = D.extractPhotoUrlsFromHtml(html);
  assert.equal(urls.length, 2); // duplicate aaa111 collapsed, non-/c/ image ignored
  assert.equal(urls[0], 'https://pictures.dealer.com/c/acct/1158/aaa111x.jpg?impolicy=downsize_bkpt&w=1200');
  assert.equal(urls[1], 'https://pictures.dealer.com/c/acct/0484/bbb222x.jpg?impolicy=downsize_bkpt&w=1200');
});

test('extractPhotoUrlsFromHtml: respects the cap', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<img src="https://pictures.dealer.com/c/acct/0000/h${i}x.jpg">`).join('');
  assert.equal(D.extractPhotoUrlsFromHtml(many, 24).length, 24);
});
