import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRESENCE_REPORTS,
  mergeStatus,
  normalizeStatus,
  recordPresence,
  sanitizeSourceUrl,
  sanitizeUsageEvent
} from './listings.js';

test("normalizeStatus: extension 'active' maps to 'listed'; junk is clamped; null passes through", () => {
  assert.equal(normalizeStatus('active'), 'listed');
  assert.equal(normalizeStatus('listed'), 'listed');
  assert.equal(normalizeStatus('sold'), 'sold');
  assert.equal(normalizeStatus('removed'), 'removed');
  assert.equal(normalizeStatus('garbage'), 'listed');
  assert.equal(normalizeStatus(null), null);
  assert.equal(normalizeStatus(undefined), null);
});

test('sanitizeUsageEvent accepts the known contract and canonicalizes its timestamp', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  const event = sanitizeUsageEvent({
    id: 'event-1',
    type: 'fill_completed',
    clientKey: 'VIN-1',
    occurredAt: '2026-07-19T11:59:00Z',
    data: { fields: [{ name: 'Price', ok: true }] }
  }, { now });
  assert.equal(event.id, 'event-1');
  assert.equal(event.occurredAt, '2026-07-19T11:59:00.000Z');
  assert.equal(JSON.parse(event.data).fields[0].name, 'Price');
});

test('sanitizeUsageEvent rejects unknown types, bad clocks, oversized keys, and large data', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  assert.equal(sanitizeUsageEvent({ id: '1', type: 'made_up' }, { now }), null);
  assert.equal(sanitizeUsageEvent({ id: '1', type: 'fill_completed', occurredAt: 'not-a-date' }, { now }), null);
  assert.equal(sanitizeUsageEvent({
    id: '1', type: 'fill_completed', occurredAt: '2026-07-20T12:00:00Z'
  }, { now }), null);
  assert.equal(sanitizeUsageEvent({
    id: '1', type: 'fill_completed', clientKey: 'x'.repeat(241)
  }, { now }), null);
  assert.equal(sanitizeUsageEvent({
    id: '1', type: 'fill_completed', data: { value: 'x'.repeat(33 * 1024) }
  }, { now }), null);
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

// ---- sold_platform attribution (multi-platform, migration 007) ----

test('incoming sold carries soldPlatform; listed clears it', () => {
  const sold = mergeStatus({ status: 'listed' }, { status: 'sold', soldSource: 'manual', soldPlatform: 'craigslist' });
  assert.equal(sold.sold_platform, 'craigslist');
  const listed = mergeStatus(null, { status: 'listed' });
  assert.equal(listed.sold_platform, null);
});

test('sticky manual sold keeps its existing sold_platform', () => {
  const existing = { status: 'sold', sold_source: 'manual', sold_at: '2026-01-01T00:00:00Z', sold_platform: 'fb' };
  const r = mergeStatus(existing, { status: 'listed' });
  assert.equal(r.sold_platform, 'fb');
});

test('incoming sold without soldPlatform preserves the existing attribution', () => {
  const existing = { status: 'sold', sold_source: 'scan', sold_platform: 'craigslist' };
  const r = mergeStatus(existing, { status: 'sold', soldSource: 'manual' });
  assert.equal(r.sold_platform, 'craigslist');
});

// ---- sanitizeSourceUrl: the SSRF/attribution gate on client-supplied URLs ----

test('sanitizeSourceUrl: valid dealer URL passes; alias pinning enforced when domains given', () => {
  const domains = ['www.alexandriatoyota.com', 'alexandriatoyota.com'];
  const url = 'https://www.alexandriatoyota.com/used-Alexandria-2021-Toyota-Corolla';
  assert.equal(sanitizeSourceUrl(url, domains), url);
  assert.equal(sanitizeSourceUrl('https://inventory.alexandriatoyota.com/vdp/1', domains),
    'https://inventory.alexandriatoyota.com/vdp/1'); // subdomain of an alias
  assert.equal(sanitizeSourceUrl('https://www.othertoyota.com/used-car', domains), null); // foreign dealer
  assert.equal(sanitizeSourceUrl('https://evil-alexandriatoyota.com/x', domains), null);  // lookalike
});

test('sanitizeSourceUrl: scheme + blocked-host hygiene applies with or without domains', () => {
  assert.equal(sanitizeSourceUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeSourceUrl('file:///etc/passwd'), null);
  assert.equal(sanitizeSourceUrl('https://127.0.0.1/admin'), null);
  assert.equal(sanitizeSourceUrl('https://0x7f.0.0.1/admin'), null);           // URL-normalized to 127.0.0.1
  assert.equal(sanitizeSourceUrl('https://postgres.railway.internal/'), null); // platform-internal
  assert.equal(sanitizeSourceUrl('https://localhost:3737/x'), null);
  assert.equal(sanitizeSourceUrl('not a url'), null);
  assert.equal(sanitizeSourceUrl(''), null);
  assert.equal(sanitizeSourceUrl(null), null);
  // No domains (unlinked user): sanity-only, a public https URL is kept.
  assert.equal(sanitizeSourceUrl('https://www.example.com/car'), 'https://www.example.com/car');
});

test('recordPresence: caps the batch — oversized payloads are dropped, not processed', async () => {
  let updates = 0;
  const db = { query: async () => { updates += 1; return { rows: [] }; } };
  const reports = Array.from({ length: MAX_PRESENCE_REPORTS + 100 }, (_, i) => ({ clientKey: `K${i}`, present: true }));
  const counts = await recordPresence('u1', reports, db);
  assert.equal(counts.present, MAX_PRESENCE_REPORTS);
  assert.equal(counts.dropped, 100);
  assert.equal(counts.total, MAX_PRESENCE_REPORTS + 100);
  assert.equal(updates, MAX_PRESENCE_REPORTS); // present = 1 update each
});

test('recordPresence: non-string / oversized clientKeys are ignored as unknown', async () => {
  let updates = 0;
  const db = { query: async () => { updates += 1; return { rows: [] }; } };
  const counts = await recordPresence('u1', [
    { clientKey: { $ne: null }, present: true },
    { clientKey: 'X'.repeat(300), present: false },
    { clientKey: 'OK1', present: true }
  ], db);
  assert.equal(counts.unknown, 2);
  assert.equal(counts.present, 1);
  assert.equal(updates, 1);
});
