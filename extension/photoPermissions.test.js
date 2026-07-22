'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('./manifest.json');

// The new dealership adapters extract photos from vendor CDNs rather than the dealership's
// own origin. MV3 service-worker fetches still need explicit host access even though the dealer
// page can render those images in <img> elements.
test('manifest grants background photo fetches for supported vendor CDNs', () => {
  const permissions = new Set(manifest.host_permissions || []);

  assert.ok(
    permissions.has('https://*.carsforsale.com/*'),
    'CarsForSale inventory photos are served from cdnNN.carsforsale.com'
  );
  assert.ok(
    permissions.has('https://photos.autocorner.com/*'),
    'AutoCorner inventory photos are served from photos.autocorner.com'
  );
});

test('pilot dealership origins are persistent and receive the dealership overlay', () => {
  const permissions = new Set(manifest.host_permissions || []);
  const dealerScript = (manifest.content_scripts || []).find((script) =>
    Array.isArray(script.js) && script.js.includes('dealerContent.js'));
  const matches = new Set((dealerScript && dealerScript.matches) || []);
  const pilots = [
    'https://*.vlautosales.com/*',
    'https://*.keithsautosales.com/*'
  ];

  for (const origin of pilots) {
    assert.ok(permissions.has(origin), `${origin} should not prompt for access on every pilot account`);
    assert.ok(matches.has(origin), `${origin} should receive the inventory overlay without dynamic registration`);
  }
});
