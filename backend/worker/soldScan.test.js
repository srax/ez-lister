import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleScan, judgeListing } from './soldScan.js';
import { extractVins } from './adapters/dealeron.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

test('isPlausibleScan: failed scan never counts', () => {
  assert.equal(isPlausibleScan({ ok: false, vinCount: 500, prevCount: 500 }), false);
});

test('isPlausibleScan: floor is max(10, 30% of prev)', () => {
  assert.equal(isPlausibleScan({ ok: true, vinCount: 9, prevCount: 0 }), false); // below 10
  assert.equal(isPlausibleScan({ ok: true, vinCount: 10, prevCount: 0 }), true);
  assert.equal(isPlausibleScan({ ok: true, vinCount: 200, prevCount: 600 }), true); // 200 >= 180
  assert.equal(isPlausibleScan({ ok: true, vinCount: 100, prevCount: 600 }), false); // 100 < 180
});

test('isPlausibleScan: null count rejected', () => {
  assert.equal(isPlausibleScan({ ok: true, vinCount: null, prevCount: 100 }), false);
});

test('judgeListing: present + no prior miss → just record last-seen', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: null }, true, T0);
  assert.equal(d.lastSeen, T0);
  assert.equal(d.clearFirstMissed, false);
  assert.ok(!d.markSold && !d.revive);
});

test('judgeListing: present + had a miss → clear the miss', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: new Date(T0 - HOUR).toISOString() }, true, T0);
  assert.equal(d.clearFirstMissed, true);
});

test('judgeListing: first absence sets first_missed_at, does not sell', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: null }, false, T0);
  assert.equal(d.setFirstMissed, T0);
  assert.ok(!d.markSold);
});

test('judgeListing: absent < 20h → no change', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: new Date(T0 - 19 * HOUR).toISOString() }, false, T0);
  assert.equal(d, null);
});

test('judgeListing: absent >= 20h → sold(scan)', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: new Date(T0 - 20 * HOUR).toISOString() }, false, T0);
  assert.equal(d.markSold, true);
  assert.equal(d.soldAt, T0);
});

test('judgeListing: scanner-sold reappears → revive', () => {
  const d = judgeListing({ status: 'sold', sold_source: 'scan', first_missed_at: null }, true, T0);
  assert.equal(d.revive, true);
});

test('extractVins: keeps only check-digit-valid VINs, dedupes, uppercases', () => {
  const html = 'x JTEABFAJ9SK020209 y jteabfaj9sk020209 z 784EA473034FD5F94 1N4BL2EP8CC223820';
  const vins = extractVins(html);
  assert.deepEqual(vins.sort(), ['1N4BL2EP8CC223820', 'JTEABFAJ9SK020209']);
});
