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
       timezone=excluded.timezone, config=excluded.config`,
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

export function genId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}
