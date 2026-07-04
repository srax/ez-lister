import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePlatform, buildEvidence } from './fingerprint.js';

test('DealerOn detected from live-DOM client signals', () => {
  const r = scorePlatform(buildEvidence({ vehicleInfoVin: true, dotagging: true }));
  assert.equal(r.platform, 'dealeron');
  assert.equal(r.scores.dealeron, 5);
  assert.ok(r.confidence > 0 && r.confidence <= 1);
});

test('DealerOn detected from server signals', () => {
  const r = scorePlatform(buildEvidence({ mentionsDealerOn: true, hasSitemapAspx: true }));
  assert.equal(r.platform, 'dealeron');
  assert.equal(r.scores.dealeron, 5);
});

test('weak single signal is below threshold → no platform', () => {
  const r = scorePlatform(buildEvidence({ hasSearchNew: true })); // weight 1 < 3
  assert.equal(r.platform, null);
  assert.equal(r.confidence, 0);
});

test('empty evidence → null platform', () => {
  assert.equal(scorePlatform(buildEvidence({})).platform, null);
  assert.equal(scorePlatform().platform, null);
});

test('all signals → max score, confidence capped at 1', () => {
  const r = scorePlatform(buildEvidence({
    vehicleInfoVin: true, dotagging: true, mentionsDealerOn: true,
    hasSitemapAspx: true, hasSearchNew: true, hasSearchUsed: true, hasInventoryPhotos: true
  }));
  assert.equal(r.scores.dealeron, 13);
  assert.equal(r.confidence, 1);
});
