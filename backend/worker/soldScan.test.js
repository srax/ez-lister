import test from 'node:test';
import assert from 'node:assert/strict';
import { dealershipsToScan, isPlausibleScan, judgeListing, resolveWithVdp } from './soldScan.js';
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

test('dealershipsToScan schedules only platforms with an implemented sold-scan adapter', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 'dealeron-only' }] };
    }
  };
  const rows = await dealershipsToScan(db, { dealeron: async () => ({ ok: true, vins: [] }) });
  assert.deepEqual(rows, [{ id: 'dealeron-only' }]);
  assert.match(calls[0].sql, /d\.platform = any\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].params, [['dealeron']]);
  assert.deepEqual(await dealershipsToScan(db, {}), []);
  assert.equal(calls.length, 1, 'no adapters means no database scan target query');
});

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

test('judgeListing: first absence sets first_missed_at + requests a probe — NEVER sells', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: null }, false, T0);
  assert.equal(d.setFirstMissed, T0);
  assert.equal(d.probe, true);
  assert.ok(!d.markSold);
});

test('judgeListing: still absent, however long — roster alone can never sell', () => {
  const d = judgeListing({ status: 'listed', first_missed_at: new Date(T0 - 100 * HOUR).toISOString() }, false, T0);
  assert.equal(d.probe, true);
  assert.equal(d.setFirstMissed, null);
  assert.ok(!d.markSold);
});

test('judgeListing: scanner-sold reappears → revive', () => {
  const d = judgeListing({ status: 'sold', sold_source: 'scan', first_missed_at: null }, true, T0);
  assert.equal(d.revive, true);
});

test('judgeListing: scanner-sold + still absent → revival probe; manual sold untouchable', () => {
  const scanSold = judgeListing({ status: 'sold', sold_source: 'scan', first_missed_at: null }, false, T0);
  assert.equal(scanSold.probe, true);
  assert.ok(!scanSold.markSold && !scanSold.revive);
  assert.equal(judgeListing({ status: 'sold', sold_source: 'manual', first_missed_at: null }, false, T0), null);
});

// ---- VDP ground truth (the anti-false-positive layer + the fast-sale clock) ----
const MIN = 60 * 1000;
const PROBE = { probe: true, setFirstMissed: null };
const CAR = { status: 'listed', sold_source: null, first_missed_at: new Date(T0 - HOUR).toISOString(), gone_confirmed_at: null };
const CAR_CONFIRMED = { ...CAR, gone_confirmed_at: new Date(T0 - 30 * MIN).toISOString() };
const SCAN_SOLD = { status: 'sold', sold_source: 'scan', first_missed_at: null, gone_confirmed_at: null };

test('resolveWithVdp: live VDP clears every clock (roster was lying)', () => {
  const d = resolveWithVdp({ decision: PROBE, listing: CAR, alive: true, now: T0 });
  assert.ok(!d.markSold);
  assert.equal(d.lastSeen, T0);
  assert.equal(d.clearFirstMissed, true);
});

test('resolveWithVdp: first gone-confirmation arms the clock, does not sell', () => {
  const d = resolveWithVdp({ decision: PROBE, listing: CAR, alive: false, now: T0 });
  assert.equal(d.setGoneConfirmed, T0);
  assert.ok(!d.markSold);
});

test('resolveWithVdp: second gone-confirmation ≥25min later → sold', () => {
  const d = resolveWithVdp({ decision: PROBE, listing: CAR_CONFIRMED, alive: false, now: T0 });
  assert.equal(d.markSold, true);
  assert.equal(d.soldAt, T0);
});

test('resolveWithVdp: second confirmation too soon (<25min) → wait for the next cycle', () => {
  const soon = { ...CAR, gone_confirmed_at: new Date(T0 - 10 * MIN).toISOString() };
  assert.equal(resolveWithVdp({ decision: PROBE, listing: soon, alive: false, now: T0 }), null);
});

test('resolveWithVdp: a stale confirmation (>48h, worker pause) restarts the pair instead of selling', () => {
  const stale = { ...CAR, gone_confirmed_at: new Date(T0 - 49 * HOUR).toISOString() };
  const d = resolveWithVdp({ decision: PROBE, listing: stale, alive: false, now: T0 });
  assert.equal(d.setGoneConfirmed, T0);
  assert.ok(!d.markSold);
});

test('resolveWithVdp: VDP unknowable → never sell, never confirm; telemetry only', () => {
  assert.equal(resolveWithVdp({ decision: PROBE, listing: CAR_CONFIRMED, alive: null, now: T0 }), null);
  const withMiss = resolveWithVdp({ decision: { probe: true, setFirstMissed: T0 }, listing: CAR, alive: null, now: T0 });
  assert.deepEqual(withMiss, { setFirstMissed: T0 });
});

test('resolveWithVdp: scanner-sold car with live VDP → revive (stale-roster self-heal)', () => {
  const d = resolveWithVdp({ decision: { probe: true }, listing: SCAN_SOLD, alive: true, now: T0 });
  assert.equal(d.revive, true);
});

test('resolveWithVdp: scanner-sold car, VDP gone or unknown → stays sold', () => {
  assert.equal(resolveWithVdp({ decision: { probe: true }, listing: SCAN_SOLD, alive: false, now: T0 }), null);
  assert.equal(resolveWithVdp({ decision: { probe: true }, listing: SCAN_SOLD, alive: null, now: T0 }), null);
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
