import crypto from 'node:crypto';
import { pool } from './db.js';
import { normalizeHost, candidateHosts } from './dealer-url.js';
import { scorePlatform, buildEvidence } from './fingerprint.js';
import { fetchSiteEvidence } from './detect.js';
import { createDealership } from './admin-ops.js';
import { activeSubscription } from './entitlement/index.js';

// Platforms our extractor actually supports end-to-end: detection at/above threshold on one
// of these AUTO-ONBOARDS the dealership (row + aliases, status 'supported') so any dealer on
// that platform can self-serve. Everything else stays curated (request → triage → admin).
const AUTO_SUPPORT_PLATFORMS = new Set(['dealeron']);

export function slugFromHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The config subset safe to hand the extension (what makes it config-driven per dealer).
function publicDealership(row) {
  const config = row.config || {};
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    timezone: row.timezone,
    location: config.location || null,
    domains: row.domains || [],
    config: {
      location: config.location || null,
      sitemapUrl: config.sitemapUrl || null,
      inventoryUrls: config.inventoryUrls || []
    }
  };
}

// Exact host match only (join alias → dealership). No fuzzy/suffix matching.
export async function findDealershipByHosts(hosts, db = pool) {
  if (!hosts || !hosts.length) return null;
  const { rows } = await db.query(
    `select d.*, array(
        select a.domain from dealership_aliases a where a.dealership_id = d.id
     ) as domains
     from dealerships d
     join dealership_aliases al on al.dealership_id = d.id
     where al.domain = any($1)
     limit 1`,
    [hosts]
  );
  return rows[0] || null;
}

// resolve: alias hit → supported dealership; miss → detected platform (triage only).
export async function resolveDealer({ url, fingerprints }, { db = pool, allowNetwork = true, fetchImpl = fetch } = {}) {
  let inputHost = null;
  let hosts = [];
  if (url) {
    try {
      const c = await candidateHosts(url, { allowNetwork, fetchImpl });
      inputHost = c.inputHost;
      hosts = c.hosts;
    } catch {
      inputHost = null;
    }
  }

  const dealership = await findDealershipByHosts(hosts, db);
  if (dealership && dealership.status === 'supported') {
    return { supported: true, dealership: publicDealership(dealership), normalizedDomain: inputHost };
  }
  if (dealership) {
    // The domain maps to a KNOWN dealership that curation disabled — never auto-revive it.
    const { platform, confidence } = scorePlatform(buildEvidence(fingerprints));
    return { supported: false, detectedPlatform: platform || dealership.platform, confidence, normalizedDomain: inputHost };
  }

  // Unknown domain → detect the platform for real: merge client fingerprints (live-DOM
  // evidence, when our script already ran there) with a one-shot server fetch of the site.
  let siteInfo = null;
  if (inputHost && allowNetwork) siteInfo = await fetchSiteEvidence(inputHost, { fetchImpl });
  const evidence = buildEvidence({ ...(fingerprints || {}), ...(siteInfo ? siteInfo.evidence : {}) });
  const { platform, confidence } = scorePlatform(evidence);

  // Supported-platform site → self-serve onboarding: create the dealership + aliases now and
  // return it as supported, so the user can connect without waiting on manual curation.
  if (platform && AUTO_SUPPORT_PLATFORMS.has(platform) && inputHost) {
    const created = await autoOnboardDealer({ inputHost, hosts, siteInfo, platform }, db);
    if (created) {
      return { supported: true, dealership: created, normalizedDomain: inputHost, autoOnboarded: true };
    }
  }

  return { supported: false, detectedPlatform: platform, confidence, normalizedDomain: inputHost };
}

// Create the dealership row + exact-match aliases for a freshly-detected supported-platform
// site. Config starts minimal: sitemapUrl only when the homepage actually references
// sitemap.aspx (enables the sold-scan roster); location stays null until known (the extension
// treats a missing location as "leave the field for the user").
async function autoOnboardDealer({ inputHost, hosts, siteInfo, platform }, db) {
  try {
    const apex = inputHost.replace(/^www\./, '');
    const domains = [...new Set([inputHost, apex, `www.${apex}`, ...(hosts || []), ...(siteInfo && siteInfo.finalHost ? [siteInfo.finalHost] : [])])];
    let id = slugFromHost(inputHost);
    if (!id) return null;
    // Slug collision guard: if the id already belongs to a DIFFERENT site (its aliases don't
    // include this host — we only get here when the alias lookup missed), suffix a stable hash
    // of the apex domain instead of silently merging two dealerships into one row.
    const clash = await db.query('select id from dealerships where id = $1', [id]);
    if (clash.rows.length) {
      id = `${id}-${crypto.createHash('sha256').update(apex).digest('hex').slice(0, 6)}`;
    }
    const name = (siteInfo && siteInfo.siteName) || apex;
    const config = {};
    if (siteInfo && siteInfo.evidence && siteInfo.evidence.hasSitemapAspx) {
      config.sitemapUrl = `https://${inputHost}/sitemap.aspx`;
    }
    await createDealership({ id, name, platform, timezone: 'America/New_York', config, domains }, db);
    const fresh = await findDealershipByHosts([inputHost], db);
    return fresh ? publicDealership(fresh) : null;
  } catch {
    return null; // creation raced/failed → fall back to the normal unsupported/request path
  }
}

// link: only supported dealerships; one per user (user_dealerships PK enforces it).
// Switching to a DIFFERENT dealership is allowed only while the account has NO live paid
// subscription (active/trialing) — once the user has paid, the dealership the subscription
// was sold for is locked; changing it is a support/admin action (/api/admin/link|unlink).
// Expired/canceled subscriptions may switch (they pay again on renewal).
export async function linkDealer(userId, dealershipId, db = pool) {
  const { rows } = await db.query('select id, status from dealerships where id = $1', [dealershipId]);
  if (!rows.length) { const e = new Error('unknown dealership'); e.status = 404; throw e; }
  if (rows[0].status !== 'supported') { const e = new Error('dealership not supported'); e.status = 400; throw e; }

  const existing = await db.query('select dealership_id from user_dealerships where user_id = $1', [userId]);
  if (existing.rows.length) {
    if (existing.rows[0].dealership_id === dealershipId) return { linked: true, dealershipId };
    const sub = await activeSubscription(userId, db);
    if (sub.active) {
      const e = new Error('Your subscription is tied to your connected dealership. Contact support to change it.');
      e.status = 409;
      e.reason = 'dealership_locked';
      throw e;
    }
    await db.query(
      'update user_dealerships set dealership_id = $2, linked_at = now() where user_id = $1',
      [userId, dealershipId]
    );
    return { linked: true, dealershipId, switched: true };
  }

  await db.query('insert into user_dealerships (user_id, dealership_id) values ($1, $2)', [userId, dealershipId]);
  return { linked: true, dealershipId };
}

export async function recordRequest(userId, {
  rawInput,
  normalizedDomain,
  detectedPlatform,
  fingerprints,
  contactName,
  contactEmail,
  contactPhone,
  notes
}, db = pool) {
  // Flood guard: the same user re-asking about the same domain dedupes to the existing
  // triage row instead of growing the table on every resolve miss or panel reload.
  const dedupeKey = normalizedDomain || rawInput || '';
  const { rows: recent } = await db.query(
    `select id from dealer_requests
     where user_id = $1 and coalesce(normalized_domain, raw_input) = $2
     limit 1`,
    [userId, dedupeKey]
  );
  if (recent.length) {
    await db.query(
      `update dealer_requests set
         contact_name = coalesce($2, contact_name),
         contact_email = coalesce($3, contact_email),
         contact_phone = coalesce($4, contact_phone),
         notes = coalesce($5, notes)
       where id = $1`,
      [recent[0].id, contactName || null, contactEmail || null, contactPhone || null, notes || null]
    );
    return { id: recent[0].id, deduped: true };
  }

  const id = crypto.randomUUID();
  await db.query(
    `insert into dealer_requests (
       id, user_id, raw_input, normalized_domain, detected_platform, fingerprints,
       contact_name, contact_email, contact_phone, notes
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id, userId, rawInput || '', normalizedDomain || null, detectedPlatform || null,
      fingerprints ? JSON.stringify(fingerprints) : null,
      contactName || null, contactEmail || null, contactPhone || null, notes || null
    ]
  );
  return { id };
}

export async function getPendingDealerRequest(userId, db = pool) {
  const { rows } = await db.query(
    `select id, raw_input, normalized_domain, detected_platform, created_at
     from dealer_requests
     where user_id = $1
     order by created_at desc
     limit 1`,
    [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    rawInput: r.raw_input,
    normalizedDomain: r.normalized_domain,
    detectedPlatform: r.detected_platform,
    createdAt: r.created_at
  };
}

// For /api/me: the user's linked dealership (public subset) or null.
export async function getUserDealership(userId, db = pool) {
  const { rows } = await db.query(
    `select d.*, array(
        select a.domain from dealership_aliases a where a.dealership_id = d.id
     ) as domains
     from user_dealerships ud
     join dealerships d on d.id = ud.dealership_id
     where ud.user_id = $1`,
    [userId]
  );
  return rows.length ? publicDealership(rows[0]) : null;
}

export { normalizeHost };
