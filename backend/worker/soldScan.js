import crypto from 'node:crypto';
import { pool } from '../db.js';
import { isEntitled } from '../entitlement/index.js';
import { pruneUsageEvents } from '../listings-admin.js';
import { fetchRoster } from './adapters/dealeron.js';

const HOUR_MS = 3600 * 1000;
const SOLD_AFTER_MS = 20 * HOUR_MS; // 20h since first miss (two misses on different days)
const RESUME_STALE_MS = 48 * HOUR_MS; // clear misses older than this on entitlement resume

const ADAPTERS = { dealeron: fetchRoster };

// ---- pure: is a completed scan plausible enough to act on? ----
// Counts only if it ran without error AND the VIN count is >= max(10, 30% of the previous
// successful count). Implausible/failed scans change NO listing state.
export function isPlausibleScan({ ok, vinCount, prevCount }) {
  if (!ok) return false;
  if (vinCount == null) return false;
  const floor = Math.max(10, Math.floor((prevCount || 0) * 0.3));
  return vinCount >= floor;
}

// ---- pure: decide one listing's next state given roster membership ----
// Returns the mutation to apply (or null for "no change"). `now` is ms.
// resumedFromPause: caller clears stale first_missed_at (>48h) BEFORE calling.
export function judgeListing(listing, present, now) {
  const firstMissed = listing.first_missed_at ? new Date(listing.first_missed_at).getTime() : null;

  if (present) {
    const out = { lastSeen: now, clearFirstMissed: firstMissed != null };
    // Reappearance of a scanner-sold car → revive. NEVER touch a manual sold.
    if (listing.status === 'sold' && listing.sold_source === 'scan') {
      out.revive = true;
    }
    return out;
  }

  // Absent. Only 'listed' cars are candidates (manual/scan sold are excluded by the query).
  if (firstMissed == null) {
    return { setFirstMissed: now };
  }
  if (now - firstMissed >= SOLD_AFTER_MS) {
    return { markSold: true, soldAt: now };
  }
  return null; // missed, but not long enough yet
}

// ---- DB-driven scan of one dealership ----
async function scanDealership(dealership, { db = pool, now = Date.now(), adapters = ADAPTERS, condStates = new Map(), isEntitledFn = isEntitled } = {}) {
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

  // 304 Not Modified → inventory unchanged since last scan; treat as "all tracked VINs present".
  if (roster.notModified) {
    await recordScan(db, { scanId, dealershipId: dealership.id, startedAt, ok: true, vinCount: prevCount, source: roster.source, error: null });
    await applyPresence(db, dealership.id, null, now, { allPresent: true, isEntitledFn });
    return { ok: true, notModified: true };
  }

  if (roster.condState) condStates.set(dealership.id, roster.condState);

  const vinCount = roster.ok ? roster.vins.length : null;
  const plausible = isPlausibleScan({ ok: roster.ok, vinCount, prevCount });
  await recordScan(db, {
    scanId, dealershipId: dealership.id, startedAt,
    ok: plausible, vinCount, source: roster.source,
    error: plausible ? null : (roster.error || `implausible vin count ${vinCount} (prev ${prevCount})`)
  });
  if (!plausible) return { ok: false, reason: 'implausible', vinCount };

  await applyPresence(db, dealership.id, new Set(roster.vins), now, { isEntitledFn });
  return { ok: true, vinCount };
}

// Apply presence/absence to every tracked listing of a dealership whose owner is entitled.
async function applyPresence(db, dealershipId, rosterSet, now, { allPresent = false, isEntitledFn = isEntitled } = {}) {
  const { rows } = await db.query(
    `select l.id, l.owner_id, l.vin, l.status, l.sold_source, l.first_missed_at
     from listings l
     where l.dealership_id = $1 and l.vin is not null
       and (l.status = 'listed' or (l.status = 'sold' and l.sold_source = 'scan'))`,
    [dealershipId]
  );

  // Entitlement is per-owner; skip paused users. On resume, clear stale misses (>48h).
  const entCache = new Map();
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

    const present = allPresent ? true : rosterSet.has(listing.vin);
    const decision = judgeListing(effective, present, now);
    if (!decision) continue;
    await applyDecision(db, effective, decision, now);
  }
}

async function applyDecision(db, listing, d, now) {
  const nowIso = new Date(now).toISOString();
  if (d.revive) {
    await db.query(
      `update listings set status='listed', sold_source=null, sold_at=null, sold_price=null,
         first_missed_at=null, last_seen_in_inventory_at=$2, updated_at=now() where id=$1`,
      [listing.id, nowIso]
    );
    return;
  }
  if (d.markSold) {
    await db.query(
      `update listings set status='sold', sold_source='scan', sold_at=$2, updated_at=now() where id=$1`,
      [listing.id, new Date(d.soldAt).toISOString()]
    );
    return;
  }
  if (d.setFirstMissed) {
    await db.query('update listings set first_missed_at=$2, updated_at=now() where id=$1', [listing.id, new Date(d.setFirstMissed).toISOString()]);
    return;
  }
  if (d.lastSeen) {
    if (d.clearFirstMissed) {
      await db.query('update listings set first_missed_at=null, last_seen_in_inventory_at=$2, updated_at=now() where id=$1', [listing.id, nowIso]);
    } else {
      await db.query('update listings set last_seen_in_inventory_at=$2 where id=$1', [listing.id, nowIso]);
    }
  }
}

async function recordScan(db, s) {
  await db.query(
    `insert into dealer_inventory_scans (id, dealership_id, started_at, finished_at, ok, vin_count, source, error)
     values ($1,$2,$3, now(), $4,$5,$6,$7)`,
    [s.scanId, s.dealershipId, s.startedAt, s.ok, s.vinCount, s.source, s.error]
  );
}

async function previousSuccessfulCount(db, dealershipId) {
  const { rows } = await db.query(
    "select vin_count from dealer_inventory_scans where dealership_id=$1 and ok=true and vin_count is not null order by started_at desc limit 1",
    [dealershipId]
  );
  return rows.length ? rows[0].vin_count : 0;
}

// Dealerships with ≥1 tracked (listed, valid-VIN) listing.
async function dealershipsToScan(db) {
  const { rows } = await db.query(
    `select distinct d.* from dealerships d
     join listings l on l.dealership_id = d.id
     where l.vin is not null and l.status = 'listed'`
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
  return results;
}

// ---- the hourly in-process loop ----
let timer = null;
export function startWorker({ intervalMs = HOUR_MS } = {}) {
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
  const firstDelay = Math.max(60 * 1000, HOUR_MS + jitter);
  timer = setTimeout(function loop() {
    tick().finally(() => { timer = setTimeout(loop, intervalMs); });
  }, firstDelay);
  console.log(`sold-scan worker armed (first run in ~${Math.round(firstDelay / 60000)} min, then every ${Math.round(intervalMs / 60000)} min)`);
}

export function stopWorker() {
  if (timer) { clearTimeout(timer); timer = null; }
}
