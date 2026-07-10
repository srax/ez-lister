'use strict';

// Unit tests for the Dealer Inspire extractor's pure helpers. Fixture strings captured from a live
// Dealer Inspire SRP (classicchevrolet.com, Cars.com) on 2026-07-10.

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./dealerinspire.js');

test('parseVehicleJson: parses the data-vehicle blob, tolerates junk', () => {
  assert.deepEqual(D.parseVehicleJson('{"vin":"ABC","year":"2019"}'), { vin: 'ABC', year: '2019' });
  assert.deepEqual(D.parseVehicleJson('not json'), {});
  assert.deepEqual(D.parseVehicleJson(''), {});
  assert.deepEqual(D.parseVehicleJson(null), {});
});

test('isRealPhoto: real DI hosts yes; chrome/stock renders + assets + other hosts no', () => {
  assert.equal(D.isRealPhoto('https://vehicle-images.carscommerce.inc/c9-1/VIN123/thumbnails/large/x.jpg'), true);
  assert.equal(D.isRealPhoto('https://vehicle-images.carscommerce.inc/stock-images/thumbnails/large/chrome/x.png'), false); // stock render
  assert.equal(D.isRealPhoto('https://di-uploads-pod47.dealerinspire.com/x/uploads/2025/08/og-200x200-1.jpg'), false);      // dealer og asset
  assert.equal(D.isRealPhoto('https://di-uploads.dealerinspire.com/x/placeholder.jpg'), false);
  assert.equal(D.isRealPhoto('https://someothercdn.com/img.jpg'), false);
});

test('photosFromHtml: only THIS car (VIN in path) — skips stock, dealer assets, and other VINs', () => {
  const VIN = '5XYPG4A36KG550522';
  const html = '<img src="https://vehicle-images.carscommerce.inc/c9-1/5XYPG4A36KG550522/thumbnails/large/a.jpg?w=520">'
    + '<img src="https://vehicle-images.carscommerce.inc/c9-1/5XYPG4A36KG550522/thumbnails/large/b.jpg">'
    + '<img src="https://vehicle-images.carscommerce.inc/c9-1/5XYPG4A36KG550522/thumbnails/large/a.jpg?w=1200">' // dupe of a
    + '<img src="https://vehicle-images.carscommerce.inc/stock-images/thumbnails/large/chrome/s.png">'          // stock
    + '<img src="https://vehicle-images.carscommerce.inc/c9-2/3KPF24AD6RE759740/thumbnails/large/other.jpg">'   // different VIN
    + '<img src="https://di-uploads-pod47.dealerinspire.com/x/uploads/2025/08/og-200x200-1.jpg">';              // dealer asset
  const urls = D.photosFromHtml(html, VIN);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://vehicle-images.carscommerce.inc/c9-1/5XYPG4A36KG550522/thumbnails/large/a.jpg');
});

test('photosFromHtml: matches ESCAPED-slash JSON URLs (the real DI gallery format)', () => {
  const VIN = '5XYPG4A36KG550522';
  const html = 'var d={"photos":["https:\\/\\/vehicle-images.carscommerce.inc\\/c9\\/5XYPG4A36KG550522\\/thumbnails\\/large\\/a.jpg",'
    + '"https:\\/\\/vehicle-images.carscommerce.inc\\/c9\\/5XYPG4A36KG550522\\/thumbnails\\/large\\/b.jpg"]};';
  const urls = D.photosFromHtml(html, VIN);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://vehicle-images.carscommerce.inc/c9/5XYPG4A36KG550522/thumbnails/large/a.jpg');
});
