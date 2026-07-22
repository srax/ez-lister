import crypto from 'node:crypto';
import { pool } from './db.js';
import { normalizeVin } from './vin.js';
import { isBlockedHost, hostMatchesDomains } from './dealer-url.js';

// ---- source_url hygiene (host enforcement) ----
// A listing's source_url is fetched later by the sold-scan worker AND the extension's
// presence check, so a client-controlled arbitrary URL is an SSRF vector (the worker would
// probe it server-side, attributed to a dealership the client merely claimed). Rules:
//   • must parse as http(s) with a non-blocked host (never an IP / localhost / *.internal);
//   • when the listing belongs to a dealership (aliasDomains given), the host must belong to
//     that dealership's alias domains — subdomains included, lookalike domains rejected;
//   • no aliasDomains (unlinked user / platform listing URL) → scheme + blocklist sanity only:
//     the worker never probes dealership-less rows, and the extension only re-fetches the
//     user's own URLs.
export function sanitizeSourceUrl(url, aliasDomains = null) {
  if (!url) return null;
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || isBlockedHost(host)) return null;
  if (aliasDomains && aliasDomains.length && !hostMatchesDomains(host, aliasDomains)) return null;
  return u.toString();
}

// The extension's local schema says 'active' where the contract says 'listed'. Accept both,
// and never store a status outside the contract's set. null/undefined stays null (partial
// updates keep the existing status).
const STATUSES = new Set(['listed', 'sold', 'removed']);
export const USAGE_EVENT_TYPES = new Set([
  'list_clicked',
  'extraction_completed',
  'fill_completed',
  'publish_detected',
  'marked_sold',
  'marked_sold_undo',
  'views_observed',
  'dealer_outcome'
]);
const MAX_EVENT_ID_LENGTH = 200;
const MAX_EVENT_KEY_LENGTH = 240;
const MAX_EVENT_DATA_BYTES = 32 * 1024;
const MAX_EVENT_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 10 * 60 * 1000;

export function sanitizeUsageEvent(ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const id = typeof ev.id === 'string' ? ev.id.trim() : '';
  const type = typeof ev.type === 'string' ? ev.type.trim() : '';
  if (!id || id.length > MAX_EVENT_ID_LENGTH || !USAGE_EVENT_TYPES.has(type)) return null;
  let clientKey = null;
  if (ev.clientKey != null) {
    clientKey = typeof ev.clientKey === 'string' ? ev.clientKey.trim() : '';
    if (!clientKey || clientKey.length > MAX_EVENT_KEY_LENGTH) return null;
  }
  const occurredMs = ev.occurredAt == null ? now : Date.parse(ev.occurredAt);
  if (!Number.isFinite(occurredMs)
      || occurredMs < now - MAX_EVENT_AGE_MS
      || occurredMs > now + MAX_EVENT_FUTURE_MS) return null;
  let data = null;
  if (ev.data != null) {
    if (typeof ev.data !== 'object') return null;
    try {
      data = JSON.stringify(ev.data);
    } catch {
      return null;
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_EVENT_DATA_BYTES) return null;
  }
  return {
    id,
    type,
    clientKey,
    data,
    occurredAt: new Date(occurredMs).toISOString()
  };
}

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
async function upsertListing(ownerId, item, db, context, getAliases = null) {
  const clientKey = item.clientKey;
  if (!clientKey) return { skipped: 'no clientKey' };

  const { rows: existingRows } = await db.query(
    `select * from listings
      where workspace_id = $1 and actor_user_id = $2 and client_key = $3`,
    [context.workspaceId, context.actorUserId, clientKey]
  );
  const existing = existingRows[0] || null;
  if (!existing && context.workspaceType === 'organization' && !context.hasSeat) {
    return { skipped: 'no active seat' };
  }
  const merged = mergeStatus(existing, item);
  const vin = normalizeVin(item.vin);
  const id = existing ? existing.id : crypto.randomUUID();

  // Dealership attribution is SERVER-resolved, never client-supplied: an existing row keeps
  // its dealership (historical attribution survives a dealership switch); a new row gets the
  // user's linked dealership. `item.dealershipId` is deliberately ignored — trusting it let a
  // client tag listings into another dealership's stats and scan set.
  const dealershipId = (existing && existing.dealership_id) || context.dealershipId;

  // Pin source_url to the row's OWN dealership (not the current link — a switched user's old
  // cars keep their old dealer's still-valid URLs). The stored value is re-validated too, so a
  // URL that predates the user's link (or a rule change) can't survive via the merge below.
  const aliases = (dealershipId && getAliases) ? await getAliases(dealershipId) : null;
  const incomingSourceUrl = sanitizeSourceUrl(item.sourceUrl, aliases);
  const existingSourceUrl = existing ? sanitizeSourceUrl(existing.source_url, aliases) : null;
  const sourceUrl = incomingSourceUrl || existingSourceUrl;

  await db.query(
    `insert into listings (
       id, owner_id, workspace_id, organization_id, actor_user_id,
       dealership_id, client_key, vin, stock, title, year, make, model, price,
       platform, status, sold_source, listed_at, sold_at, sold_price, sold_platform, source_url,
       facebook_listing_id, facebook_listing_url, facebook_published_at,
       views_count, views_observed_at, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27, now()
     )
     on conflict (workspace_id, actor_user_id, client_key)
       where workspace_id is not null and actor_user_id is not null do update set
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
       source_url = excluded.source_url,
       facebook_listing_id = coalesce(excluded.facebook_listing_id, listings.facebook_listing_id),
       facebook_listing_url = coalesce(excluded.facebook_listing_url, listings.facebook_listing_url),
       facebook_published_at = coalesce(excluded.facebook_published_at, listings.facebook_published_at),
       updated_at = now()`,
    [
      id, ownerId, context.workspaceId, context.organizationId, context.actorUserId,
      dealershipId, clientKey, vin, item.stock || null, item.title || null,
      item.year || null, item.make || null, item.model || null, item.price ?? null,
      item.platform || 'fb', merged.status, merged.sold_source, item.listedAt || null,
      merged.sold_at, merged.sold_price, merged.sold_platform, sourceUrl,
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
        [id, String(p.platform), p.status === 'removed' ? 'removed' : 'listed', p.listedAt || null, sanitizeSourceUrl(p.url)]
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
async function insertEvent(ownerId, ev, db, context) {
  const event = sanitizeUsageEvent(ev);
  if (!event) return { skipped: true, reason: 'invalid_event' };
  if (context.workspaceType === 'organization' && !context.hasSeat && event.clientKey) {
    const { rows } = await db.query(
      `select 1 from listings
        where workspace_id=$1 and actor_user_id=$2 and client_key=$3 limit 1`,
      [context.workspaceId, context.actorUserId, event.clientKey]
    );
    if (!rows.length) return { skipped: true };
  }
  const inserted = await db.query(
    `insert into usage_events (
       id, user_id, workspace_id, organization_id, actor_user_id,
       type, client_key, data, occurred_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do nothing returning id`,
    [
      event.id, ownerId, context.workspaceId, context.organizationId, context.actorUserId,
      event.type, event.clientKey, event.data, event.occurredAt
    ]
  );
  if (!inserted.rows.length) return { ok: true, duplicate: true };

  if (event.type === 'marked_sold_undo' && event.clientKey) {
    await db.query(
      `update listings set status = 'listed', sold_source = null, sold_at = null, sold_price = null, sold_platform = null, updated_at = now()
       where workspace_id = $1 and actor_user_id=$2 and client_key = $3 and sold_source = 'manual'`,
      [context.workspaceId, context.actorUserId, event.clientKey]
    );
  }

  // Part 2: the user classified a removed-from-dealership car (sold at fb/craigslist by the
  // dealership, or delisted). Sets the outcome tag only — it deliberately does NOT touch
  // status/sold_*: a dealership outcome is not the user's personal sale, and the stats layer
  // excludes outcome'd cars from Active on its own.
  if (event.type === 'dealer_outcome' && event.clientKey) {
    const eventData = event.data ? JSON.parse(event.data) : null;
    const outcome = eventData && eventData.outcome;
    if (DEALER_OUTCOMES.has(outcome)) {
      await db.query(
        `update listings set dealer_outcome = $4, dealer_outcome_at = $5, updated_at = now()
          where workspace_id = $1 and actor_user_id=$2 and client_key = $3`,
        [context.workspaceId, context.actorUserId, event.clientKey, outcome, event.occurredAt]
      );
    }
  }

  // A fresh publish is definitive evidence the car is live again — it beats even a sticky
  // manual sold, but only when the publish happened AFTER the car was marked sold (so a
  // replayed old event can't un-sell anything).
  if (event.type === 'publish_detected' && event.clientKey) {
    await db.query(
      `update listings set status = 'listed', sold_source = null, sold_at = null, sold_price = null, sold_platform = null,
         first_missed_at = null, updated_at = now()
       where workspace_id = $1 and actor_user_id=$2 and client_key = $3 and status = 'sold'
         and (sold_at is null or sold_at < $4)`,
      [context.workspaceId, context.actorUserId, event.clientKey, event.occurredAt]
    );
  }
  return { ok: true };
}

// ---- the sync entrypoint (auth only, not entitlement) ----
export async function syncListings(ownerId, { listings = [], events = [], context = null } = {}, db = pool) {
  const results = { listings: 0, events: 0 };
  // Every listing's dealership is the user's SERVER-side link (existing rows keep theirs);
  // the client's claim is ignored — see upsertListing. Aliases are loaded once per dealership
  // to pin each row's source_url to that dealership's domains.
  const effectiveContext = context || {
    workspaceId: `personal:${ownerId}`,
    workspaceType: 'personal',
    organizationId: null,
    dealershipId: null,
    actorUserId: ownerId,
    role: 'personal',
    hasSeat: true
  };
  if (!effectiveContext.dealershipId && listings.length) {
    const { rows } = await db.query('select dealership_id from user_dealerships where user_id = $1', [ownerId]);
    effectiveContext.dealershipId = rows.length ? rows[0].dealership_id : null;
  }
  const aliasCache = new Map();
  const getAliases = async (dealershipId) => {
    if (!aliasCache.has(dealershipId)) {
      const { rows } = await db.query('select domain from dealership_aliases where dealership_id = $1', [dealershipId]);
      aliasCache.set(dealershipId, rows.map((r) => r.domain));
    }
    return aliasCache.get(dealershipId);
  };
  for (const item of listings) {
    const r = await upsertListing(ownerId, item, db, effectiveContext, getAliases);
    if (r && r.id) results.listings += 1;
  }
  for (const ev of events) {
    const r = await insertEvent(ownerId, ev, db, effectiveContext);
    if (r && r.ok) results.events += 1;
  }
  return results;
}

export async function getListings(ownerId, db = pool, context = null) {
  let where = 'l.owner_id = $1';
  let params = [ownerId];
  if (context) {
    where = 'l.workspace_id = $1 and l.dealership_id = $2';
    params = [context.workspaceId, context.dealershipId];
    if (context.workspaceType === 'organization' && !['owner', 'manager'].includes(context.role)) {
      where += ' and l.actor_user_id = $3';
      params.push(context.actorUserId);
    }
  }
  const { rows } = await db.query(
    `select l.id, l.client_key, l.vin, l.stock, l.title, l.year, l.make, l.model, l.price,
            l.platform, l.status, l.sold_source, l.sold_platform,
            l.listed_at, l.sold_at, l.sold_price, l.source_url, l.facebook_listing_url,
            l.views_count, l.views_observed_at,
            l.gone_confirmed_at, l.dealer_outcome, l.dealer_outcome_at,
            coalesce(
              json_agg(json_build_object(
                'platform', lp.platform, 'status', lp.status,
                'listedAt', lp.listed_at, 'url', lp.listing_url
              )) filter (where lp.listing_id is not null),
              '[]'
            ) as platforms
     from listings l
     left join listing_platforms lp on lp.listing_id = l.id
     where ${where}
     group by l.id
     order by coalesce(l.listed_at, l.created_at) desc`,
    params
  );
  return rows;
}

// ---- inventory presence check (Part 1: telemetry only, no selling) ----

// The user's currently-listed cars that have a detail-page URL to check. Device-independent
// (the backend is the source of truth), so the extension checks the right set regardless of
// which device did the listing. Cars the user already classified (dealer_outcome) are done —
// no point re-probing them.
export async function getCarsToCheck(ownerId, db = pool, context = null) {
  const where = context
    ? 'workspace_id = $1 and dealership_id = $2 and actor_user_id = $3'
    : 'owner_id = $1';
  const params = context
    ? [context.workspaceId, context.dealershipId, context.actorUserId]
    : [ownerId];
  const { rows } = await db.query(
    `select client_key as "clientKey", vin, source_url as "sourceUrl"
       from listings
      where ${where} and status = 'listed' and vin is not null and source_url is not null
        and dealer_outcome is null`,
    params
  );
  return rows;
}

// A second gone report must be at least this far after first_missed_at before we confirm the car
// gone (needs-action in the panel). The check cadence is 3h, so a real removal confirms on the
// very next sweep, while one transient blip can never confirm on its own.
export const GONE_CONFIRM_MIN_GAP = '2 hours';

// Record the extension's per-car presence verdicts.
//   present → last_seen updated; BOTH miss clocks cleared (auto-revive: a car back on the site
//             cancels any pending/confirmed gone state before the user has classified it).
//   gone    → first miss starts the clock; a second miss ≥ GONE_CONFIRM_MIN_GAP later promotes to
//             gone_confirmed_at — the panel's "needs action" signal. Never confirms on one miss.
//   unknown (null) → no-op, never acted on (bot-wall / network / 5xx).
// Only touches 'listed' rows without a dealer_outcome (classified cars are settled). Selling
// still never happens here — the user decides in the panel.
// Capped: each report costs up to two UPDATEs, and the legit set (the user's own listed cars)
// is far below the cap — an oversized payload is abuse, not data.
export const MAX_PRESENCE_REPORTS = 500;
export async function recordPresence(ownerId, reports = [], db = pool, context = null) {
  const scope = context
    ? 'workspace_id = $1 and dealership_id = $4 and actor_user_id = $5'
    : 'owner_id = $1';
  const queryParams = (key, at) => context
    ? [context.workspaceId, key, at, context.dealershipId, context.actorUserId]
    : [ownerId, key, at];
  const all = Array.isArray(reports) ? reports : [];
  const capped = all.slice(0, MAX_PRESENCE_REPORTS);
  const counts = { present: 0, gone: 0, unknown: 0, total: all.length, dropped: all.length - capped.length };
  for (const r of capped) {
    const key = r && typeof r.clientKey === 'string' && r.clientKey.length <= 200 ? r.clientKey : null;
    if (!key) { counts.unknown += 1; continue; }
    const parsed = r.checkedAt ? new Date(r.checkedAt) : new Date();
    const at = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    if (r.present === true) {
      await db.query(
        `update listings set last_seen_in_inventory_at = $3, first_missed_at = null, gone_confirmed_at = null, updated_at = now()
          where ${scope} and client_key = $2 and status = 'listed' and dealer_outcome is null`,
        queryParams(key, at)
      );
      counts.present += 1;
    } else if (r.present === false) {
      // Two-confirm: promote to confirmed-gone only when an earlier, separate miss is old enough.
      // Runs BEFORE the coalesce below so this report can't self-confirm.
      await db.query(
        `update listings set gone_confirmed_at = coalesce(gone_confirmed_at, $3), updated_at = now()
          where ${scope} and client_key = $2 and status = 'listed' and dealer_outcome is null
            and first_missed_at is not null and first_missed_at <= $3::timestamptz - interval '${GONE_CONFIRM_MIN_GAP}'`,
        queryParams(key, at)
      );
      await db.query(
        `update listings set first_missed_at = coalesce(first_missed_at, $3), updated_at = now()
          where ${scope} and client_key = $2 and status = 'listed' and dealer_outcome is null`,
        queryParams(key, at)
      );
      counts.gone += 1;
    } else {
      counts.unknown += 1; // null/unknown → never act
    }
  }
  return counts;
}

// ---- Part 2: the user's classification of a removed-from-dealership car ----
export const DEALER_OUTCOMES = new Set(['fb', 'craigslist', 'delisted']);
