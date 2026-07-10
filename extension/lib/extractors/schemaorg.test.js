'use strict';

// Unit tests for the shared, platform-agnostic schema.org vehicle parser.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./schemaorg.js');

const HTML = `<html><head>
<script type="application/ld+json">{"@type":"WebSite","name":"Some Dealer"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Car","vehicleIdentificationNumber":"1hgcv1f42ma012345","name":"2021 Honda Accord EX-L","brand":{"name":"Honda"},"model":"Accord","vehicleModelDate":"2021","mileageFromOdometer":{"value":"38,210"},"vehicleTransmission":"Automatic","fuelType":"Gasoline","bodyType":"Sedan","color":"Modern Steel Metallic","vehicleInteriorColor":"Black","offers":{"price":"27995","priceCurrency":"USD"},"image":["https://x/1.jpg","https://x/2.jpg"]}</script>
</head><body></body></html>`;

test('vehicleFromHtml: pulls the Vehicle/Car node, normalizes, ignores non-vehicle nodes', () => {
  const v = S.vehicleFromHtml(HTML);
  assert.equal(v.vin, '1HGCV1F42MA012345'); // upper-cased
  assert.equal(v.year, '2021');
  assert.equal(v.make, 'Honda');            // brand.name
  assert.equal(v.model, 'Accord');
  assert.equal(v.mileage, 38210);           // "38,210" → 38210
  assert.equal(v.transmission, 'Automatic');
  assert.equal(v.fuelType, 'Gasoline');
  assert.equal(v.bodyType, 'Sedan');
  assert.equal(v.exteriorColor, 'Modern Steel Metallic');
  assert.equal(v.interiorColor, 'Black');
  assert.equal(v.price, 27995);             // offers.price
  assert.deepEqual(v.photos, ['https://x/1.jpg', 'https://x/2.jpg']);
});

test('vehicleFromHtml: @graph wrapper is flattened', () => {
  const html = '<script type="application/ld+json">{"@graph":[{"@type":"Vehicle","vehicleIdentificationNumber":"ABC","offers":{"price":"1000"}}]}</script>';
  const v = S.vehicleFromHtml(html);
  assert.equal(v.vin, 'ABC');
  assert.equal(v.price, 1000);
});

test('vehicleFromHtml: no vehicle data → empty (only photos array)', () => {
  const v = S.vehicleFromHtml('<script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>');
  assert.equal(v.vin, undefined);
  assert.deepEqual(v.photos, []);
});

test('vehicleFromHtml: malformed JSON is skipped, not thrown', () => {
  assert.doesNotThrow(() => S.vehicleFromHtml('<script type="application/ld+json">{ not json </script>'));
});
