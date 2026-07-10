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

test('isRealPhoto: real DI hosts yes; chrome stock renders + placeholders + other hosts no', () => {
  assert.equal(D.isRealPhoto('https://di-uploads-pod47.dealerinspire.com/x/uploads/img1.jpg'), true);
  assert.equal(D.isRealPhoto('https://vehicle-images.carscommerce.inc/photos/real.jpg'), true);
  assert.equal(D.isRealPhoto('https://vehicle-images.carscommerce.inc/stock-images/chrome/x.png'), false); // stock render
  assert.equal(D.isRealPhoto('https://di-uploads.dealerinspire.com/x/placeholder.jpg'), false);
  assert.equal(D.isRealPhoto('https://someothercdn.com/img.jpg'), false);
});

test('photosFromHtml: unique real DI photos, skips stock renders + dupes', () => {
  const html = '<img src="https://di-uploads-pod47.dealerinspire.com/a/1.jpg?w=520">'
    + '<img src="https://di-uploads-pod47.dealerinspire.com/a/2.jpg">'
    + '<img src="https://di-uploads-pod47.dealerinspire.com/a/1.jpg?w=1200">'  // dupe of #1
    + '<img src="https://vehicle-images.carscommerce.inc/stock-images/chrome/s.png">'; // stock render
  const urls = D.photosFromHtml(html);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://di-uploads-pod47.dealerinspire.com/a/1.jpg');
});

test('photosFromHtml: matches ESCAPED-slash JSON URLs (the real DI gallery format)', () => {
  // DI ships gallery URLs inside JSON blobs with escaped slashes: https:\/\/di-uploads…
  const html = 'var d={"photos":["https:\\/\\/di-uploads-pod47.dealerinspire.com\\/acct\\/uploads\\/a.jpg",'
    + '"https:\\/\\/di-uploads-pod47.dealerinspire.com\\/acct\\/uploads\\/b.jpg"]};';
  const urls = D.photosFromHtml(html);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://di-uploads-pod47.dealerinspire.com/acct/uploads/a.jpg');
});
