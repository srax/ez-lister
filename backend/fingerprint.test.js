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

// ---- Dealer.com (Cox Automotive): Akamai 403s the server fetch, so detection must clear
// threshold on the CLIENT fingerprints the extractor posts from the live DOM. ----
test('Dealer.com detected from window.DDC alone (client)', () => {
  const r = scorePlatform(buildEvidence({ ddcNamespace: true }));
  assert.equal(r.platform, 'dealercom');
  assert.equal(r.scores.dealercom, 3);
});

test('Dealer.com detected from card + inventory-path client signals', () => {
  const r = scorePlatform(buildEvidence({ vehicleCardUuid: true, ddcInventoryPath: true }));
  assert.equal(r.platform, 'dealercom');
  assert.equal(r.scores.dealercom, 3);
});

test('Dealer.com server marker (non-walled site) clears threshold', () => {
  const r = scorePlatform(buildEvidence({ mentionsDealerDotCom: true }));
  assert.equal(r.platform, 'dealercom');
  assert.equal(r.scores.dealercom, 3);
});

test('a lone weak Dealer.com card signal stays below threshold', () => {
  const r = scorePlatform(buildEvidence({ vehicleCardUuid: true })); // weight 2 < 3
  assert.equal(r.platform, null);
});

test('DealerOn and Dealer.com signals do not cross-contaminate', () => {
  const ron = scorePlatform(buildEvidence({ vehicleInfoVin: true }));
  assert.equal(ron.scores.dealercom, 0);
  const com = scorePlatform(buildEvidence({ ddcNamespace: true }));
  assert.equal(com.scores.dealeron, 0);
});

test('Dealer Inspire detected from its client asset/data-vehicle signal', () => {
  const r = scorePlatform(buildEvidence({ diAssets: true }));
  assert.equal(r.platform, 'dealerinspire');
  assert.equal(r.scores.dealerinspire, 3);
  assert.equal(r.scores.dealeron, 0);
  assert.equal(r.scores.dealercom, 0);
});
