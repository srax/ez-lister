import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListing } from './normalize.js';

test('normalizes the captured Facebook reference structure', () => {
  const listing = normalizeListing({
    url: 'https://example.test/car',
    pageTitle: '2025 Toyota Land Cruiser - Dealer',
    pageText: [
      '2025 Toyota land cruiser',
      '$54,970',
      'Listed a day ago in Alexandria, VA',
      'Driven 9,582 miles',
      'Automatic transmission',
      'Exterior color: Grey · Interior color: Black',
      'Fuel type: Hybrid',
      'Excellent condition',
      'Clean title',
      '- **VIN:** JTEABFAJ9SK020209',
      '- **Stock #:** 00P30392',
      '- **Body Style:** Sport Utility',
      '- **Engine:** 4 Cyl - 2.4 L',
      '- **City/Highway MPG:** 22/25'
    ].join('\n'),
    images: [
      { url: 'https://cdn.example.test/1.jpg', width: 1200, height: 800 },
      { url: 'https://cdn.example.test/1.jpg', width: 1200, height: 800 },
      { url: 'https://cdn.example.test/2.jpg', width: 1200, height: 800 }
    ]
  });

  assert.equal(listing.title, '2025 Toyota Land Cruiser');
  assert.equal(listing.price, 54970);
  assert.equal(listing.mileage, 9582);
  assert.equal(listing.vin, 'JTEABFAJ9SK020209');
  assert.equal(listing.stockNumber, '00P30392');
  assert.equal(listing.bodyStyle, 'Sport Utility');
  assert.equal(listing.transmission, 'Automatic');
  assert.equal(listing.fuelType, 'Hybrid');
  assert.equal(listing.location, 'Alexandria, VA');
  assert.equal(listing.photos.length, 2);
  assert.match(listing.description, /Message Sayed for test drive/);
});
