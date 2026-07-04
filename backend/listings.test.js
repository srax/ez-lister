import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStatus, normalizeStatus } from './listings.js';

test("normalizeStatus: extension 'active' maps to 'listed'; junk is clamped; null passes through", () => {
  assert.equal(normalizeStatus('active'), 'listed');
  assert.equal(normalizeStatus('listed'), 'listed');
  assert.equal(normalizeStatus('sold'), 'sold');
  assert.equal(normalizeStatus('removed'), 'removed');
  assert.equal(normalizeStatus('garbage'), 'listed');
  assert.equal(normalizeStatus(null), null);
  assert.equal(normalizeStatus(undefined), null);
});

test("mergeStatus: incoming extension 'active' is stored as 'listed'", () => {
  const r = mergeStatus(null, { status: 'active' });
  assert.equal(r.status, 'listed');
});

test('mergeStatus: incoming row without a status keeps the existing status', () => {
  const r = mergeStatus({ status: 'removed' }, {});
  assert.equal(r.status, 'removed');
});

test('new listing → listed, no sold fields', () => {
  const r = mergeStatus(null, { status: 'listed' });
  assert.equal(r.status, 'listed');
  assert.equal(r.sold_source, null);
});

test('manual sold is sticky — a synced listed row never revives it', () => {
  const existing = { status: 'sold', sold_source: 'manual', sold_at: '2026-01-01T00:00:00Z', sold_price: 5000 };
  const r = mergeStatus(existing, { status: 'listed' });
  assert.equal(r.status, 'sold');
  assert.equal(r.sold_source, 'manual');
  assert.equal(r.sold_at, '2026-01-01T00:00:00Z');
});

test('scanner sold is NOT revived by a synced listed row (scan handles reappearance itself)', () => {
  const existing = { status: 'sold', sold_source: 'scan', sold_at: '2026-01-02T00:00:00Z', sold_price: null };
  const r = mergeStatus(existing, { status: 'listed' });
  assert.equal(r.status, 'sold');
  assert.equal(r.sold_source, 'scan');
});

test('incoming manual sold beats an existing scanner sold', () => {
  const existing = { status: 'sold', sold_source: 'scan', sold_at: '2026-01-02T00:00:00Z' };
  const r = mergeStatus(existing, { status: 'sold', soldSource: 'manual', soldAt: '2026-01-03T00:00:00Z', soldPrice: 6000 });
  assert.equal(r.sold_source, 'manual');
  assert.equal(r.sold_at, '2026-01-03T00:00:00Z');
  assert.equal(r.sold_price, 6000);
});

test('incoming manual sold on a listed car sets sold fields', () => {
  const r = mergeStatus({ status: 'listed' }, { status: 'sold', soldSource: 'manual', soldAt: '2026-02-01T00:00:00Z', soldPrice: 4200 });
  assert.equal(r.status, 'sold');
  assert.equal(r.sold_source, 'manual');
  assert.equal(r.sold_price, 4200);
});
