'use strict';

// Unit tests for the platform registry (platforms.js). Locks the fallback contract the
// router relies on: unknown/empty platform ids must resolve to the default (Facebook), so
// every legacy caller that sends no `platform` keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPlatform, DEFAULT_PLATFORM, PLATFORMS } = require('./platforms.js');

test('default platform is facebook and is registered', () => {
  assert.equal(DEFAULT_PLATFORM, 'fb');
  assert.ok(PLATFORMS.fb);
  assert.equal(PLATFORMS.fb.id, 'fb');
});

test('getPlatform resolves a known id', () => {
  assert.equal(getPlatform('fb').id, 'fb');
});

test('getPlatform falls back to the default for unknown/empty ids', () => {
  assert.equal(getPlatform(undefined).id, 'fb');
  assert.equal(getPlatform('').id, 'fb');
  assert.equal(getPlatform('nope').id, 'fb');
  assert.equal(getPlatform(null).id, 'fb');
});

test('every platform entry has the fields the router uses', () => {
  for (const p of Object.values(PLATFORMS)) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.label, 'string');
    assert.match(p.createUrl, /^https:\/\//);
    assert.equal(typeof p.isCreateUrl, 'function');
  }
});

test('fb.isCreateUrl matches only the marketplace vehicle-create page', () => {
  const fb = PLATFORMS.fb;
  assert.equal(fb.isCreateUrl('https://www.facebook.com/marketplace/create/vehicle'), true);
  assert.equal(fb.isCreateUrl('https://www.facebook.com/marketplace/create/vehicle?ref=x'), true);
  assert.equal(fb.isCreateUrl('https://www.facebook.com/marketplace/you/selling'), false);
  assert.equal(fb.isCreateUrl('https://www.facebook.com/'), false);
  assert.equal(fb.isCreateUrl(''), false);
  assert.equal(fb.isCreateUrl(undefined), false);
});
