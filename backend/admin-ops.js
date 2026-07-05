import crypto from 'node:crypto';
import { pool } from './db.js';

// Admin data ops (ADMIN_TOKEN-gated at the route). Curated dealer onboarding + triage.
// comp-grant lives with billing agent B per the contract; everything else is A's.

export async function listDealerRequests(limit = 100, db = pool) {
  const { rows } = await db.query(
    `select id, user_id, raw_input, normalized_domain, detected_platform, created_at
     from dealer_requests order by created_at desc limit $1`,
    [Math.min(500, Math.max(1, limit))]
  );
  return rows;
}

// Create/curate a supported dealership + its exact-match aliases (the "add a dealer on a
// supported platform" path). Idempotent on id and domains.
export async function createDealership({ id, name, platform, timezone, config, domains = [] }, db = pool) {
  if (!id || !name || !platform) { const e = new Error('id, name, platform required'); e.status = 400; throw e; }
  await db.query(
    `insert into dealerships (id, name, platform, status, timezone, config)
     values ($1,$2,$3,'supported',$4,$5)
     on conflict (id) do update set name=excluded.name, platform=excluded.platform,
       timezone=excluded.timezone, config=excluded.config, status='supported'`,
    [id, name, platform, timezone || 'America/New_York', JSON.stringify(config || {})]
  );
  for (const domain of domains) {
    await db.query(
      'insert into dealership_aliases (domain, dealership_id) values ($1,$2) on conflict (domain) do update set dealership_id=excluded.dealership_id',
      [String(domain).toLowerCase(), id]
    );
  }
  return { id, domains };
}

// Manual link / unlink / switch (switching is admin-only in v1).
export async function adminLink(userId, dealershipId, db = pool) {
  if (!userId || !dealershipId) { const e = new Error('userId, dealershipId required'); e.status = 400; throw e; }
  const d = await db.query("select id from dealerships where id=$1 and status='supported'", [dealershipId]);
  if (!d.rows.length) { const e = new Error('unknown or unsupported dealership'); e.status = 404; throw e; }
  await db.query(
    `insert into user_dealerships (user_id, dealership_id) values ($1,$2)
     on conflict (user_id) do update set dealership_id=excluded.dealership_id, linked_at=now()`,
    [userId, dealershipId]
  );
  return { linked: true, userId, dealershipId };
}

export async function adminUnlink(userId, db = pool) {
  const { rowCount } = await db.query('delete from user_dealerships where user_id=$1', [userId]);
  return { unlinked: rowCount > 0 };
}

export async function recentScans(limit = 50, db = pool) {
  const { rows } = await db.query(
    `select id, dealership_id, started_at, finished_at, ok, vin_count, source, error
     from dealer_inventory_scans order by started_at desc limit $1`,
    [Math.min(500, Math.max(1, limit))]
  );
  return rows;
}

// comp grant (entitlement without Stripe — friends/testing). Grant or revoke by email.
// Entitlement still requires a linked dealership (isEntitled), so comped testers link a
// supported dealership first; the grant just substitutes for an active subscription.
export async function compGrant({ email, expiresAt, note }, db = pool) {
  if (!email) { const e = new Error('email required'); e.status = 400; throw e; }
  const { rows } = await db.query('select id from "user" where lower(email) = lower($1)', [email]);
  if (!rows.length) { const e = new Error('no user with that email (they must sign in once first)'); e.status = 404; throw e; }
  await db.query(
    `insert into comp_grants (user_id, expires_at, note) values ($1,$2,$3)
     on conflict (user_id) do update set expires_at=excluded.expires_at, note=excluded.note`,
    [rows[0].id, expiresAt || null, note || null]
  );
  return { granted: true, userId: rows[0].id, email, expiresAt: expiresAt || null };
}

export async function compRevoke({ email }, db = pool) {
  if (!email) { const e = new Error('email required'); e.status = 400; throw e; }
  const { rows } = await db.query('select id from "user" where lower(email) = lower($1)', [email]);
  if (!rows.length) { const e = new Error('no user with that email'); e.status = 404; throw e; }
  const { rowCount } = await db.query('delete from comp_grants where user_id=$1', [rows[0].id]);
  return { revoked: rowCount > 0, userId: rows[0].id, email };
}

// One-call ops snapshot: who signed up, what's linked/entitled, listings by user,
// event volume, last scan, AI spend. Everything the "is prod healthy?" question needs.
export async function overview(db = pool) {
  const [users, subs, comps, listings, events, scan, ai] = await Promise.all([
    db.query(
      `select u.id, u.email, u."createdAt" as created_at,
              ud.dealership_id, cg.user_id is not null as comp,
              count(l.id) filter (where l.status = 'listed') as active_listings,
              count(l.id) filter (where l.status = 'sold') as sold_listings
       from "user" u
       left join user_dealerships ud on ud.user_id = u.id
       left join comp_grants cg on cg.user_id = u.id
       left join listings l on l.owner_id = u.id
       group by u.id, u.email, u."createdAt", ud.dealership_id, cg.user_id
       order by u."createdAt" desc limit 50`
    ),
    db.query('select status, count(*)::int as n from "subscription" group by status'),
    db.query('select count(*)::int as n from comp_grants'),
    db.query('select status, count(*)::int as n from listings group by status'),
    db.query(
      `select type, count(*)::int as n from usage_events
       where occurred_at > now() - interval '7 days' group by type order by n desc`
    ),
    db.query(
      `select dealership_id, started_at, finished_at, ok, vin_count, source, error
       from dealer_inventory_scans order by started_at desc limit 1`
    ),
    db.query(
      `select coalesce(sum(describe_count),0)::int as describe, coalesce(sum(translate_count),0)::int as translate
       from ai_usage where day = current_date`
    )
  ]);
  return {
    users: users.rows,
    subscriptionsByStatus: subs.rows,
    compGrants: comps.rows[0].n,
    listingsByStatus: listings.rows,
    events7d: events.rows,
    lastScan: scan.rows[0] || null,
    aiToday: ai.rows[0]
  };
}

export function genId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}
