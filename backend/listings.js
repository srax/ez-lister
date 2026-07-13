import crypto from 'node:crypto';
import { pool } from './db.js';
import { normalizeVin } from './vin.js';

// The extension's local schema says 'active' where the contract says 'listed'. Accept both,
// and never store a status outside the contract's set. null/undefined stays null (partial
// updates keep the existing status).
const STATUSES = new Set(['listed', 'sold', 'removed']);
export function normalizeStatus(s) {
  if (s == null) return null;
  const v = s === 'active' ? 'listed' : String(s);
  return STATUSES.has(v) ? v : 'listed';
}

// ---- pure status-merge precedence (contract §Sync) ----
// manual sold always wins; the scanner never overrides a manual sold; an incoming listing
// row from the extension never downgrades a sold car (the extension only sends published
// cars as 'listed'). Returns the fields to persist for status/sold_*.
export function mergeStatus(existing, incoming) {
  const cur = existing || {};
  const incomingStatus = normalizeStatus(incoming.status);
  // A manual sold is sticky — nothing from a sync downgrades it.
  if (cur.status === 'sold' && cur.sold_source === 'manual') {
    return { status: 'sold', sold_source: 'manual', sold_at: cur.sold_at, sold_price: cur.sold_price, sold_platform: cur.sold_platform ?? null };
  }
  // Incoming explicit manual sold (from a marked_sold action synced as a listing row).
  if (incomingStatus === 'sold') {
    return {
      status: 'sold',
      sold_source: incoming.soldSource || cur.sold_source || 'manual',
      sold_at: incoming.soldAt || cur.sold_at || new Date().toISOString(),
      sold_price: incoming.soldPrice != null ? incoming.soldPrice : cur.sold_price ?? null,
      sold_platform: incoming.soldPlatform || cur.sold_platform || null
    };
  }
  // Incoming 'listed' never un-sells a scanner-sold car; keep the sold state.
  if (cur.status === 'sold') {
    return { status: 'sold', sold_source: cur.sold_source, sold_at: cur.sold_at, sold_price: cur.sold_price, sold_platform: cur.sold_platform ?? null };
  }
  return { status: incomingStatus || normalizeStatus(cur.status) || 'listed', sold_source: null, sold_at: null, sold_price: null, sold_platform: null };
}

// ---- DB upsert of one listing ----
async function upsertListing(ownerId, item, db, defaultDealershipId = null) {
  const clientKey = item.clientKey;
  if (!clientKey) return { skipped: 'no clientKey' };

  const { rows: existingRows } = await db.query(
    'select * from listings where owner_id = $1 and client_key = $2',
    [ownerId, clientKey]
  );
  const existing = existingRows[0] || null;
  const merged = mergeStatus(existing, item);
  const vin = normalizeVin(item.vin);
  const id = existing ? existing.id : crypto.randomUUID();

  await db.query(
    `insert into listings (
       id, owner_id, dealership_id, client_key, vin, stock, title, year, make, model, price,
       platform, status, sold_source, listed_at, sold_at, sold_price, sold_platform, source_url,
       facebook_listing_id, facebook_listing_url, facebook_published_at,
       views_count, views_observed_at, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now()
     )
     on conflict (owner_id, client_key) do update set
       dealership_id = coalesce(excluded.dealership_id, listings.dealership_id),
       vin = coalesce(excluded.vin, listings.vin),
       stock = coalesce(excluded.stock, listings.stock),
       title = coalesce(excluded.title, listings.title),
       year = coalesce(excluded.year, listings.year),
       make = coalesce(excluded.make, listings.make),
       model = coalesce(excluded.model, listings.model),
       price = coalesce(excluded.price, listings.price),
       platform = excluded.platform,
       status = excluded.status,
       sold_source = excluded.sold_source,
       listed_at = coalesce(listings.listed_at, excluded.listed_at),
       sold_at = excluded.sold_at,
       sold_price = excluded.sold_price,
       sold_platform = excluded.sold_platform,
       source_url = coalesce(excluded.source_url, listings.source_url),
       facebook_listing_id = coalesce(excluded.facebook_listing_id, listings.facebook_listing_id),
       facebook_listing_url = coalesce(excluded.facebook_listing_url, listings.facebook_listing_url),
       facebook_published_at = coalesce(excluded.facebook_published_at, listings.facebook_published_at),
       updated_at = now()`,
    [
      id, ownerId, item.dealershipId || defaultDealershipId, clientKey, vin, item.stock || null, item.title || null,
      item.year || null, item.make || null, item.model || null, item.price ?? null,
      item.platform || 'fb', merged.status, merged.sold_source, item.listedAt || null,
      merged.sold_at, merged.sold_price, merged.sold_platform, item.sourceUrl || null,
      item.facebookListingId || null, item.facebookListingUrl || null, item.facebookPublishedAt || null,
      item.viewsCount ?? null, item.viewsObservedAt || null
    ]
  );

  // Per-platform presence (multi-marketplace). Additive upsert per child row: a platform is
  // never deleted by a sync that omits it (partial payloads from older clients must not erase
  // newer state); 'removed' arrives as an explicit status.
  if (Array.isArray(item.platforms)) {
    for (const p of item.platforms) {
      if (!p || !p.platform) continue;
      await db.query(
        `insert into listing_platforms (listing_id, platform, status, listed_at, listing_url, updated_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (listing_id, platform) do update set
           status = excluded.status,
           listed_at = coalesce(listing_platforms.listed_at, excluded.listed_at),
           listing_url = coalesce(excluded.listing_url, listing_platforms.listing_url),
           updated_at = now()`,
        [id, String(p.platform), p.status === 'removed' ? 'removed' : 'listed', p.listedAt || null, p.url || null]
      );
    }
  }

  // Views snapshot (append-only) + keep latest-on-listing.
  if (item.viewsCount != null && item.viewsObservedAt) {
    await db.query(
      `insert into listing_view_snapshots (listing_id, views_count, observed_at)
       values ($1, $2, $3) on conflict (listing_id, observed_at) do nothing`,
      [id, item.viewsCount, item.viewsObservedAt]
    );
    await db.query(
      `update listings set views_count = $2, views_observed_at = $3
       where id = $1 and (views_observed_at is null or views_observed_at < $3)`,
      [id, item.viewsCount, item.viewsObservedAt]
    );
  }

  return { id, status: merged.status };
}

// ---- events: idempotent insert; a marked_sold_undo reverts to listed ----
async function insertEvent(ownerId, ev, db) {
  if (!ev || !ev.id || !ev.type) return { skipped: true };
  await db.query(
    `insert into usage_events (id, user_id, type, client_key, data, occurred_at)
     values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
    [ev.id, ownerId, ev.type, ev.clientKey || null, ev.data ? JSON.stringify(ev.data) : null, ev.occurredAt || new Date().toISOString()]
  );

  if (ev.type === 'marked_sold_undo' && ev.clientKey) {
    await db.query(
      `update listings set status = 'listed', sold_source = null, sold_at = null, sold_price = null, sold_platform = null, updated_at = now()
       where owner_id = $1 and client_key = $2 and sold_source = 'manual'`,
      [ownerId, ev.clientKey]
    );
  }

  // A fresh publish is definitive evidence the car is live again — it beats even a sticky
  // manual sold, but only when the publish happened AFTER the car was marked sold (so a
  // replayed old event can't un-sell anything).
  if (ev.type === 'publish_detected' && ev.clientKey) {
    await db.query(
      `update listings set status = 'listed', sold_source = null, sold_at = null, sold_price = null, sold_platform = null,
         first_missed_at = null, updated_at = now()
       where owner_id = $1 and client_key = $2 and status = 'sold'
         and (sold_at is null or sold_at < $3)`,
      [ownerId, ev.clientKey, ev.occurredAt || new Date().toISOString()]
    );
  }
  return { ok: true };
}

// ---- the sync entrypoint (auth only, not entitlement) ----
export async function syncListings(ownerId, { listings = [], events = [] } = {}, db = pool) {
  const results = { listings: 0, events: 0 };
  // Listings synced without an explicit dealershipId inherit the user's linked dealership —
  // the sold-scan worker only sees listings that carry a dealership_id.
  let defaultDealershipId = null;
  if (listings.length) {
    const { rows } = await db.query('select dealership_id from user_dealerships where user_id = $1', [ownerId]);
    defaultDealershipId = rows.length ? rows[0].dealership_id : null;
  }
  for (const item of listings) {
    const r = await upsertListing(ownerId, item, db, defaultDealershipId);
    if (r && r.id) results.listings += 1;
  }
  for (const ev of events) {
    const r = await insertEvent(ownerId, ev, db);
    if (r && r.ok) results.events += 1;
  }
  return results;
}

export async function getListings(ownerId, db = pool) {
  const { rows } = await db.query(
    `select l.id, l.client_key, l.vin, l.stock, l.title, l.year, l.make, l.model, l.price,
            l.platform, l.status, l.sold_source, l.sold_platform,
            l.listed_at, l.sold_at, l.sold_price, l.source_url, l.facebook_listing_url,
            l.views_count, l.views_observed_at,
            coalesce(
              json_agg(json_build_object(
                'platform', lp.platform, 'status', lp.status,
                'listedAt', lp.listed_at, 'url', lp.listing_url
              )) filter (where lp.listing_id is not null),
              '[]'
            ) as platforms
     from listings l
     left join listing_platforms lp on lp.listing_id = l.id
     where l.owner_id = $1
     group by l.id
     order by coalesce(l.listed_at, l.created_at) desc`,
    [ownerId]
  );
  return rows;
}

// ---- inventory presence check (Part 1: telemetry only, no selling) ----

// The user's currently-listed cars that have a detail-page URL to check. Device-independent
// (the backend is the source of truth), so the extension checks the right set regardless of
// which device did the listing.
export async function getCarsToCheck(ownerId, db = pool) {
  const { rows } = await db.query(
    `select client_key as "clientKey", vin, source_url as "sourceUrl"
       from listings
      where owner_id = $1 and status = 'listed' and vin is not null and source_url is not null`,
    [ownerId]
  );
  return rows;
}

// Record the extension's per-car presence verdicts. PART 1 = telemetry ONLY (no status change,
// no selling): a car seen present updates last_seen + clears the miss clock; a car whose page is
// gone starts the first_missed clock; 'unknown' (null) changes nothing. Only touches 'listed'
// rows. Part 2 will read first_missed_at to drive the confirmed sold decision.
export async function recordPresence(ownerId, reports = [], db = pool) {
  const counts = { present: 0, gone: 0, unknown: 0, total: Array.isArray(reports) ? reports.length : 0 };
  for (const r of Array.isArray(reports) ? reports : []) {
    const key = r && r.clientKey;
    if (!key) { counts.unknown += 1; continue; }
    const parsed = r.checkedAt ? new Date(r.checkedAt) : new Date();
    const at = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    if (r.present === true) {
      await db.query(
        `update listings set last_seen_in_inventory_at = $3, first_missed_at = null, updated_at = now()
          where owner_id = $1 and client_key = $2 and status = 'listed'`,
        [ownerId, key, at]
      );
      counts.present += 1;
    } else if (r.present === false) {
      await db.query(
        `update listings set first_missed_at = coalesce(first_missed_at, $3), updated_at = now()
          where owner_id = $1 and client_key = $2 and status = 'listed'`,
        [ownerId, key, at]
      );
      counts.gone += 1;
    } else {
      counts.unknown += 1; // null/unknown → never act
    }
  }
  return counts;
}
