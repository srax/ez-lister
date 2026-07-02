import crypto from 'node:crypto';
import { pool } from './db.js';
import { normalizeVin } from './vin.js';

// ---- pure status-merge precedence (contract §Sync) ----
// manual sold always wins; the scanner never overrides a manual sold; an incoming listing
// row from the extension never downgrades a sold car (the extension only sends published
// cars as 'listed'). Returns the fields to persist for status/sold_*.
export function mergeStatus(existing, incoming) {
  const cur = existing || {};
  // A manual sold is sticky — nothing from a sync downgrades it.
  if (cur.status === 'sold' && cur.sold_source === 'manual') {
    return { status: 'sold', sold_source: 'manual', sold_at: cur.sold_at, sold_price: cur.sold_price };
  }
  // Incoming explicit manual sold (from a marked_sold action synced as a listing row).
  if (incoming.status === 'sold') {
    return {
      status: 'sold',
      sold_source: incoming.soldSource || cur.sold_source || 'manual',
      sold_at: incoming.soldAt || cur.sold_at || new Date().toISOString(),
      sold_price: incoming.soldPrice != null ? incoming.soldPrice : cur.sold_price ?? null
    };
  }
  // Incoming 'listed' never un-sells a scanner-sold car; keep the sold state.
  if (cur.status === 'sold') {
    return { status: 'sold', sold_source: cur.sold_source, sold_at: cur.sold_at, sold_price: cur.sold_price };
  }
  return { status: incoming.status || cur.status || 'listed', sold_source: null, sold_at: null, sold_price: null };
}

// ---- DB upsert of one listing ----
async function upsertListing(ownerId, item, db) {
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
       platform, status, sold_source, listed_at, sold_at, sold_price, source_url,
       facebook_listing_id, facebook_listing_url, facebook_published_at,
       views_count, views_observed_at, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now()
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
       source_url = coalesce(excluded.source_url, listings.source_url),
       facebook_listing_id = coalesce(excluded.facebook_listing_id, listings.facebook_listing_id),
       facebook_listing_url = coalesce(excluded.facebook_listing_url, listings.facebook_listing_url),
       facebook_published_at = coalesce(excluded.facebook_published_at, listings.facebook_published_at),
       updated_at = now()`,
    [
      id, ownerId, item.dealershipId || null, clientKey, vin, item.stock || null, item.title || null,
      item.year || null, item.make || null, item.model || null, item.price ?? null,
      item.platform || 'fb', merged.status, merged.sold_source, item.listedAt || null,
      merged.sold_at, merged.sold_price, item.sourceUrl || null,
      item.facebookListingId || null, item.facebookListingUrl || null, item.facebookPublishedAt || null,
      item.viewsCount ?? null, item.viewsObservedAt || null
    ]
  );

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
      `update listings set status = 'listed', sold_source = null, sold_at = null, sold_price = null, updated_at = now()
       where owner_id = $1 and client_key = $2 and sold_source = 'manual'`,
      [ownerId, ev.clientKey]
    );
  }
  return { ok: true };
}

// ---- the sync entrypoint (auth only, not entitlement) ----
export async function syncListings(ownerId, { listings = [], events = [] } = {}, db = pool) {
  const results = { listings: 0, events: 0 };
  for (const item of listings) {
    const r = await upsertListing(ownerId, item, db);
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
    `select id, client_key, vin, stock, title, year, make, model, price, status, sold_source,
            listed_at, sold_at, sold_price, source_url, facebook_listing_url,
            views_count, views_observed_at
     from listings where owner_id = $1 order by coalesce(listed_at, created_at) desc`,
    [ownerId]
  );
  return rows;
}
