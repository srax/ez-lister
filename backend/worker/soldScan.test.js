import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleScan, judgeListing, resolveWithVdp } from './soldScan.js';
import { extractVins, fetchRoster, checkVdpAlive } from './adapters/dealeron.js';
import { isValidVin } from '../vin.js';

// Synthesize n distinct check-digit-valid VINs (brute-force position 9 per serial).
function makeVins(n) {
  const out = [];
  for (let serial = 0; out.length < n; serial += 1) {
    const tail = String(serial).padStart(6, '0');
    for (const cd of '0123456789X') {
      const v = `JTEABFAJ${cd}SK${tail}`;
      if (isValidVin(v)) { out.push(v); break; }
    }
  }
  return out;
}

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-06-01T00:00:00Z');

test('isPlausibleScan: failed scan never counts', () => {
  assert.equal(isPlausibleScan({ ok: false, vinCount: 500, prevCount: 500 }), false);
});

test('isPlausibleScan: floor is 30% of prev; first scan needs ≥3; small dealers stay scannable', () => {
  assert.equal(isPlausibleScan({ ok: true, vinCount: 2, prevCount: 0 }), false); // first scan needs ≥3
  assert.equal(isPlausibleScan({ ok: true, vinCount: 3, prevCount: 0 }), true);
  assert.equal(isPlausibleScan({ ok: true, vinCount: 8, prevCount: 8 }), true); // 8-car dealer keeps scanning
  assert.equal(isPlausibleScan({ ok: true, vinCount: 1, prevCount: 8 }), false); // 1 < floor 2
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

test('judgeListing: already-sold + still absent → no change (sold_at must not drift)', () => {
  const d = judgeListing(
    { status: 'sold', sold_source: 'scan', first_missed_at: new Date(T0 - 30 * HOUR).toISOString() },
    false, T0
  );
  assert.equal(d, null);
});

// ---- VDP ground truth (the anti-false-positive layer) ----
const CAR = { status: 'listed', sold_source: null, first_missed_at: new Date(T0 - 21 * HOUR).toISOString() };
const SCAN_SOLD = { status: 'sold', sold_source: 'scan', first_missed_at: null };

test('resolveWithVdp: live VDP vetoes a mature-miss sale and clears the clock', () => {
  const d = resolveWithVdp({ decision: { markSold: true, soldAt: T0 }, listing: CAR, alive: true, now: T0 });
  assert.ok(!d.markSold);
  assert.equal(d.lastSeen, T0);
  assert.equal(d.clearFirstMissed, true);
});

test('resolveWithVdp: VDP confirmed gone → the sale proceeds', () => {
  const d = resolveWithVdp({ decision: { markSold: true, soldAt: T0 }, listing: CAR, alive: false, now: T0 });
  assert.equal(d.markSold, true);
});

test('resolveWithVdp: VDP unknowable → never sell blind, defer', () => {
  const d = resolveWithVdp({ decision: { markSold: true, soldAt: T0 }, listing: CAR, alive: null, now: T0 });
  assert.equal(d, null);
});

test('resolveWithVdp: scanner-sold car with live VDP → revive (stale-roster self-heal)', () => {
  const d = resolveWithVdp({ decision: null, listing: SCAN_SOLD, alive: true, now: T0 });
  assert.equal(d.revive, true);
});

test('resolveWithVdp: scanner-sold car, VDP gone or unknown → stays sold', () => {
  assert.equal(resolveWithVdp({ decision: null, listing: SCAN_SOLD, alive: false, now: T0 }), null);
  assert.equal(resolveWithVdp({ decision: null, listing: SCAN_SOLD, alive: null, now: T0 }), null);
});

test('checkVdpAlive: 200 with the VIN in the body → alive', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<div data-vin="jteabfaj9sk020209">' });
  assert.equal(await checkVdpAlive('https://d.example/car-JTEABFAJ9SK020209', 'JTEABFAJ9SK020209', { fetchImpl }), true);
});

test('checkVdpAlive: 200 without the VIN (redirected to SRP / "no longer available") → gone', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<h1>Inventory</h1>' });
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl }), false);
});

test('checkVdpAlive: 404/410 → gone; 403/5xx/network error → unknown (null)', async () => {
  const mk = (status, ok = false) => async () => ({ ok, status, text: async () => '' });
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl: mk(404) }), false);
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl: mk(410) }), false);
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl: mk(403) }), null);
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl: mk(503) }), null);
  const boom = async () => { throw new Error('net'); };
  assert.equal(await checkVdpAlive('https://d.example/car', 'JTEABFAJ9SK020209', { fetchImpl: boom }), null);
});

test('fetchRoster: sitemap fetch is cache-busted (Varnish stale-while-revalidate defense)', async () => {
  const dealership = { config: { sitemapUrl: 'https://dealer.example/sitemap.aspx' } };
  const seen = [];
  const vins = makeVins(5);
  const fetchImpl = async (url) => {
    seen.push(url);
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => vins.join(' ') };
  };
  await fetchRoster(dealership, { fetchImpl, condState: {} });
  assert.ok(seen[0].includes('cxfresh='), `expected cache-buster in ${seen[0]}`);
});

test('fetchRoster: 304 reuses the cached roster, never "all present"', async () => {
  const dealership = { config: { sitemapUrl: 'https://dealer.example/sitemap.aspx' } };
  const fetchImpl = async () => ({ status: 304, ok: false, headers: { get: () => null } });
  const cached = ['JTEABFAJ9SK020209'];
  const withCache = await fetchRoster(dealership, { fetchImpl, condState: { etag: 'x', vins: cached } });
  assert.equal(withCache.notModified, true);
  assert.deepEqual(withCache.vins, cached);
  const noCache = await fetchRoster(dealership, { fetchImpl, condState: { etag: 'x' } });
  assert.equal(noCache.notModified, true);
  assert.equal(noCache.vins, null); // caller must skip state changes, not assume presence
});

test('fetchRoster: 200 caches the roster for later 304s', async () => {
  const dealership = { config: { sitemapUrl: 'https://dealer.example/sitemap.aspx' } };
  const vins = makeVins(12);
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: { get: (h) => (h === 'etag' ? '"abc"' : null) },
    text: async () => vins.join(' ')
  });
  const r = await fetchRoster(dealership, { fetchImpl, condState: {} });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.condState.vins].sort(), [...vins].sort());
  assert.equal(r.condState.etag, '"abc"');
});

test('extractVins: keeps only check-digit-valid VINs, dedupes, uppercases', () => {
  const html = 'x JTEABFAJ9SK020209 y jteabfaj9sk020209 z 784EA473034FD5F94 1N4BL2EP8CC223820';
  const vins = extractVins(html);
  assert.deepEqual(vins.sort(), ['1N4BL2EP8CC223820', 'JTEABFAJ9SK020209']);
});
