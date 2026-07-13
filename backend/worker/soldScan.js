import crypto from 'node:crypto';
import { pool } from '../db.js';
import { isEntitled } from '../entitlement/index.js';
import { pruneUsageEvents } from '../listings-admin.js';
import { pruneExpiredAuthCodes } from '../auth-codes.js';
import { fetchRoster, checkVdpAlive } from './adapters/dealeron.js';

const HOUR_MS = 3600 * 1000;
const SCAN_INTERVAL_MS = 3 * HOUR_MS; // roster check cadence (3h)
const CONFIRM_GAP_MS = 25 * 60 * 1000; // second gone-confirmation must be ≥25min after the first
                                       // (at a 3h cadence the real gap is ~3h, so a sale lands ~6h after the car leaves)
const RESUME_STALE_MS = 48 * HOUR_MS; // clear miss/confirm clocks older than this (worker pause)
const PROBE_BUDGET = 10; // VDP ground-truth fetches per dealership per cycle (politeFetch spaces them ≥2s)

const ADAPTERS = { dealeron: fetchRoster };
const VDP_CHECKERS = { dealeron: checkVdpAlive };

// ---- pure: is a completed scan plausible enough to act on? ----
// Counts only if it ran without error AND the VIN count is plausible: ≥30% of the last
// successful count (floor 1), or ≥3 when there is no history yet. A hard floor of 10 would
// permanently disable sold detection for small dealers; ≥3 on the first scan still rejects
// a bot-walled or garbage parse. Implausible/failed scans change NO listing state.
export function isPlausibleScan({ ok, vinCount, prevCount }) {
  if (!ok) return false;
  if (vinCount == null) return false;
  const floor = prevCount > 0 ? Math.max(1, Math.floor(prevCount * 0.3)) : 3;
  return vinCount >= floor;
}

// ---- pure: decide one listing's next state given roster membership ----
// Returns the mutation/probe request to apply (or null for "no change"). `now` is ms.
// The roster NEVER sells on its own anymore — absence only starts telemetry and requests
// a VDP ground-truth probe. Selling is exclusively resolveWithVdp's call (two confirmed-
// gone probes ≥ CONFIRM_GAP_MS apart), which is what caps detection at ~30–60 min while
// staying immune to stale-CDN rosters (the 2026-07-05 false positive).
export function judgeListing(listing, present, now) {
  const firstMissed = listing.first_missed_at ? new Date(listing.first_missed_at).getTime() : null;
  const goneConfirmed = listing.gone_confirmed_at ? new Date(listing.gone_confirmed_at).getTime() : null;

  if (present) {
    const out = { lastSeen: now, clearFirstMissed: firstMissed != null || goneConfirmed != null };
    // Reappearance of a scanner-sold car → revive. NEVER touch a manual sold.
    if (listing.status === 'sold' && listing.sold_source === 'scan') {
      out.revive = true;
    }
    return out;
  }

  // Absent. Manual solds are final; scanner-solds get a revival probe (roster blind spots
  // must self-heal); 'listed' cars start the miss telemetry and request ground truth.
  if (listing.status === 'sold') {
    return listing.sold_source === 'scan' ? { probe: true } : null;
  }
  return { probe: true, setFirstMissed: firstMissed == null ? now : null };
}

// ---- pure: merge the roster verdict with VDP ground truth ----
// The roster is a secondary source (a sitemap behind a CDN that can serve days-stale
// copies); the car's own page is primary. A live VDP always wins — it clears every clock,
// and it revives a scanner-sold car whose roster source went stale. A sale requires TWO
// gone-confirmations ≥ confirmGapMs apart (a slug change or transient 404 can't sell in
// one shot). Unknown (bot wall / 5xx / network) never sells and never confirms.
export function resolveWithVdp({ decision, listing, alive, now, confirmGapMs = CONFIRM_GAP_MS, staleMs = RESUME_STALE_MS }) {
  if (alive === true) {
    if (listing.status === 'sold' && listing.sold_source === 'scan') return { revive: true };
    return { lastSeen: now, clearFirstMissed: listing.first_missed_at != null || listing.gone_confirmed_at != null };
  }
  if (alive === false && listing.status === 'listed') {
    const prev = listing.gone_confirmed_at ? new Date(listing.gone_confirmed_at).getTime() : null;
    if (prev == null || now - prev > staleMs) {
      // First confirmation (or a stale one from around a worker pause — restart the pair).
      return { setFirstMissed: (decision && decision.setFirstMissed) || null, setGoneConfirmed: now };
    }
    if (now - prev >= confirmGapMs) return { markSold: true, soldAt: now };
    return keepTelemetry(decision); // confirmed twice but too close together — next cycle decides
  }
  return keepTelemetry(decision); // unknown, or a scan-sold car still gone → no state change
}

function keepTelemetry(decision) {
  return decision && decision.setFirstMissed ? { setFirstMissed: decision.setFirstMissed } : null;
}

// ---- DB-driven scan of one dealership ----
async function scanDealership(dealership, { db = pool, now = Date.now(), adapters = ADAPTERS, vdpCheckers = VDP_CHECKERS, condStates = new Map(), isEntitledFn = isEntitled } = {}) {
  const adapter = adapters[dealership.platform];
  const scanId = crypto.randomUUID();
  const startedAt = new Date(now).toISOString();

  if (!adapter) {
    await recordScan(db, { scanId, dealershipId: dealership.id, startedAt, ok: false, vinCount: null, source: null, error: `no adapter for ${dealership.platform}` });
    return { ok: false, reason: 'no_adapter' };
  }

  const prevCount = await previousSuccessfulCount(db, dealership.id);
  const condState = condStates.get(dealership.id) || {};

  let roster;
  try {
    roster = await adapter(dealership, { condState });
  } catch (err) {
    await recordScan(db, { scanId, dealershipId: dealership.id, startedAt, ok: false, vinCount: null, source: null, error: err.message });
    return { ok: false, reason: 'fetch_threw' };
  }

  // 304 Not Modified → roster identical to the last 200 scan; re-apply that cached roster.
  // Never assume "all present": that would revive scanner-sold cars and reset miss clocks
  // for VINs that are in fact still absent. With no cached roster (fresh process), we can't
  // know membership — record the scan and change no listing state.
  const vdpCheck = vdpCheckers[dealership.platform] || null;

  if (roster.notModified) {
    const vinCount = roster.vins ? roster.vins.length : prevCount;
    await recordScan(db, { scanId, dealershipId: dealership.id, startedAt, ok: true, vinCount, source: roster.source, error: null, meta: { cache: { revalidated: true } } });
    if (!roster.vins) return { ok: true, notModified: true, skipped: 'no cached roster' };
    const counters = await applyPresence(db, dealership.id, new Set(roster.vins), now, { isEntitledFn, vdpCheck });
    await updateScanMeta(db, scanId, { cache: { revalidated: true }, counters });
    return { ok: true, notModified: true, vinCount };
  }

  if (roster.condState) condStates.set(dealership.id, roster.condState);

  const vinCount = roster.ok ? roster.vins.length : null;
  const plausible = isPlausibleScan({ ok: roster.ok, vinCount, prevCount });
  const meta = { cache: roster.cacheMeta || null };
  await recordScan(db, {
    scanId, dealershipId: dealership.id, startedAt,
    ok: plausible, vinCount, source: roster.source, meta,
    error: plausible ? null : (roster.error || `implausible vin count ${vinCount} (prev ${prevCount})`)
  });
  if (!plausible) return { ok: false, reason: 'implausible', vinCount };

  const counters = await applyPresence(db, dealership.id, new Set(roster.vins), now, { isEntitledFn, vdpCheck });
  await updateScanMeta(db, scanId, { ...meta, counters });
  return { ok: true, vinCount, ...counters };
}

// Apply presence/absence to every tracked listing of a dealership whose owner is entitled.
// Returns decision counters for the scan record — the trace that makes a false positive
// diagnosable from logs instead of forensics.
async function applyPresence(db, dealershipId, rosterSet, now, { isEntitledFn = isEntitled, vdpCheck = null } = {}) {
  const { rows } = await db.query(
    `select l.id, l.owner_id, l.client_key, l.vin, l.status, l.sold_source,
            l.first_missed_at, l.gone_confirmed_at, l.source_url
     from listings l
     where l.dealership_id = $1 and l.vin is not null
       and (l.status = 'listed' or (l.status = 'sold' and l.sold_source = 'scan'))`,
    [dealershipId]
  );

  const counters = { tracked: rows.length, absent: 0, probed: 0, vetoAlive: 0, goneConfirmed: 0, sold: 0, revived: 0, probeUnknown: 0, probeSkipped: 0 };
  const logEvent = (listing, event, extra = '') =>
    console.log(`sold-scan[${dealershipId}] vin=${listing.vin} owner=${listing.owner_id} event=${event}${extra ? ' ' + extra : ''}`);

  // Entitlement is per-owner; skip paused users. On resume, clear stale misses (>48h).
  const entCache = new Map();
  let probeBudget = PROBE_BUDGET;
  for (const listing of rows) {
    let ent = entCache.get(listing.owner_id);
    if (!ent) { ent = await isEntitledFn(listing.owner_id); entCache.set(listing.owner_id, ent); }
    if (!ent.entitled) continue;

    // Resume hygiene: a first_missed_at older than 48h (accumulated around a pause) is stale.
    let effective = listing;
    if (listing.first_missed_at && now - new Date(listing.first_missed_at).getTime() > RESUME_STALE_MS) {
      await db.query('update listings set first_missed_at = null where id = $1', [listing.id]);
      effective = { ...listing, first_missed_at: null };
    }

    const present = rosterSet.has(listing.vin);
    if (!present) counters.absent += 1;
    let decision = judgeListing(effective, present, now);

    if (decision && decision.probe) {
      const canProbe = vdpCheck && listing.source_url;
      if (canProbe && probeBudget > 0) {
        probeBudget -= 1;
        counters.probed += 1;
        const alive = await vdpCheck(listing.source_url, listing.vin).catch(() => null);
        decision = resolveWithVdp({ decision, listing: effective, alive, now });
        if (alive === true) { counters.vetoAlive += 1; logEvent(listing, decision && decision.revive ? 'revive' : 'alive_veto'); }
        else if (alive === null) { counters.probeUnknown += 1; logEvent(listing, 'probe_unknown'); }
        else if (decision && decision.markSold) { counters.sold += 1; logEvent(listing, 'sold', 'evidence=vdp_gone_x2'); }
        else if (decision && decision.setGoneConfirmed) { counters.goneConfirmed += 1; logEvent(listing, 'gone_confirmed_1'); }
      } else {
        // No checker / no source_url / budget spent: keep the telemetry clock, never sell blind.
        counters.probeSkipped += 1;
        decision = keepTelemetry(decision);
      }
    }

    if (!decision) continue;
    if (decision.revive) { counters.revived += 1; logEvent(listing, 'revive'); }
    await applyDecision(db, effective, decision, now);

    // Scan decisions that change what the salesperson sees become user-visible events too.
    if (decision.markSold || decision.revive) {
      await db.query(
        `insert into usage_events (id, user_id, type, client_key, data, occurred_at)
         values ($1,$2,$3,$4,$5,now()) on conflict (id) do nothing`,
        [crypto.randomUUID(), listing.owner_id, decision.markSold ? 'scan_marked_sold' : 'scan_revived',
         listing.client_key, JSON.stringify({ vin: listing.vin, dealershipId })]
      ).catch(() => {});
    }
  }
  return counters;
}

async function applyDecision(db, listing, d, now) {
  const nowIso = new Date(now).toISOString();
  if (d.revive) {
    await db.query(
      `update listings set status='listed', sold_source=null, sold_at=null, sold_price=null,
         first_missed_at=null, gone_confirmed_at=null, last_seen_in_inventory_at=$2, updated_at=now() where id=$1`,
      [listing.id, nowIso]
    );
    return;
  }
  if (d.markSold) {
    // Clear both clocks so a later revive → re-miss starts fresh.
    await db.query(
      `update listings set status='sold', sold_source='scan', sold_at=$2, first_missed_at=null, gone_confirmed_at=null, updated_at=now() where id=$1`,
      [listing.id, new Date(d.soldAt).toISOString()]
    );
    return;
  }
  if (d.setFirstMissed || d.setGoneConfirmed) {
    await db.query(
      `update listings set
         first_missed_at = coalesce($2, first_missed_at),
         gone_confirmed_at = coalesce($3, gone_confirmed_at),
         updated_at = now()
       where id = $1`,
      [listing.id,
       d.setFirstMissed ? new Date(d.setFirstMissed).toISOString() : null,
       d.setGoneConfirmed ? new Date(d.setGoneConfirmed).toISOString() : null]
    );
    return;
  }
  if (d.lastSeen) {
    if (d.clearFirstMissed) {
      await db.query('update listings set first_missed_at=null, gone_confirmed_at=null, last_seen_in_inventory_at=$2, updated_at=now() where id=$1', [listing.id, nowIso]);
    } else {
      await db.query('update listings set last_seen_in_inventory_at=$2 where id=$1', [listing.id, nowIso]);
    }
  }
}

async function recordScan(db, s) {
  await db.query(
    `insert into dealer_inventory_scans (id, dealership_id, started_at, finished_at, ok, vin_count, source, error, meta)
     values ($1,$2,$3, now(), $4,$5,$6,$7,$8)`,
    [s.scanId, s.dealershipId, s.startedAt, s.ok, s.vinCount, s.source, s.error, s.meta ? JSON.stringify(s.meta) : null]
  );
}

// Decision counters land after applyPresence so the scan row carries its full trace.
async function updateScanMeta(db, scanId, meta) {
  await db.query('update dealer_inventory_scans set meta = $2 where id = $1', [scanId, JSON.stringify(meta)]).catch(() => {});
}

async function previousSuccessfulCount(db, dealershipId) {
  const { rows } = await db.query(
    "select vin_count from dealer_inventory_scans where dealership_id=$1 and ok=true and vin_count is not null order by started_at desc limit 1",
    [dealershipId]
  );
  return rows.length ? rows[0].vin_count : 0;
}

// Dealerships with ≥1 tracked valid-VIN listing that a scan could still change: 'listed'
// cars (miss clock) AND scanner-sold cars (revival) — otherwise a dealership whose tracked
// cars are all scan-sold drops out of the cycle and reappearances are never noticed.
async function dealershipsToScan(db) {
  const { rows } = await db.query(
    `select distinct d.* from dealerships d
     join listings l on l.dealership_id = d.id
     where d.status = 'supported'
       and l.vin is not null
       and (l.status = 'listed' or (l.status = 'sold' and l.sold_source = 'scan'))`
  );
  return rows;
}

// One full cycle over all dealerships (exported for tests / manual runs).
export async function runScanCycle({ db = pool, now = Date.now(), condStates = new Map(), adapters = ADAPTERS, isEntitledFn = isEntitled } = {}) {
  const dealerships = await dealershipsToScan(db);
  const results = [];
  for (const d of dealerships) {
    results.push({ dealership: d.id, ...(await scanDealership(d, { db, now, condStates, adapters, isEntitledFn })) });
  }
  await pruneUsageEvents(db).catch(() => {});
  await pruneExpiredAuthCodes(db).catch(() => {});
  return results;
}

// ---- the in-process loop (every 3h; sale needs two gone-confirms, so real-world sold
// detection lands ~6h after the car leaves the dealer site) ----
let timer = null;
export function startWorker({ intervalMs = SCAN_INTERVAL_MS } = {}) {
  if (timer) return;
  const condStates = new Map();
  const tick = async () => {
    try {
      const res = await runScanCycle({ condStates });
      console.log(`sold-scan: ${res.length} dealership(s) scanned`);
    } catch (err) {
      console.error(`sold-scan error: ${err.message}`);
    }
  };
  // Jittered first run (±5 min) so restarts don't stampede a dealer host. Deterministic
  // jitter (no Math.random dependency): based on the process start clock.
  const jitter = (Date.now() % (10 * 60 * 1000)) - 5 * 60 * 1000;
  const firstDelay = Math.max(60 * 1000, intervalMs + jitter);
  timer = setTimeout(function loop() {
    tick().finally(() => { timer = setTimeout(loop, intervalMs); });
  }, firstDelay);
  console.log(`sold-scan worker armed (first run in ~${Math.round(firstDelay / 60000)} min, then every ${Math.round(intervalMs / 60000)} min)`);
}

export function stopWorker() {
  if (timer) { clearTimeout(timer); timer = null; }
}
