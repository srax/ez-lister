import '../env.js';
import { SignJWT } from 'jose';
import { pool } from '../db.js';
import { getSigningKey } from './keys.js';

// ENTITLEMENT — billing agent (B). Source of truth for "can this user use the paid product".
// Consumed by /api/me (lease), the AI bearer gate, and the listings gate — all already wired
// to this module, so making isEntitled real opens those gates with no other edits.

export { jwksHandler } from './keys.js';

const LEASE_TTL_SECONDS = 90 * 60;

// Entitled = (an active/trialing subscription whose period hasn't ended OR a live comp grant)
// AND the user has linked a supported dealership. The reason lets the extension render the
// right gate step: sign in → link dealership → subscribe → ready.
// → { entitled, reason: 'ok'|'no_subscription'|'expired'|'no_dealership', periodEnd: Date|null }
// Is there a LIVE paid subscription? active/trialing with no period end (or one still in the
// future); a stale 'active' row whose period already passed counts as expired (belt-and-braces).
// Shared by entitlement AND the dealership-switch lock so the two can never drift apart.
export async function activeSubscription(userId, db = pool) {
  const { rows } = await db.query(
    `select "periodEnd" from "subscription"
      where "referenceId" = $1 and status in ('active', 'trialing')
      order by "periodEnd" desc nulls last
      limit 1`,
    [userId]
  );
  if (!rows.length) return { active: false, hadRow: false, periodEnd: null };
  const periodEnd = rows[0].periodEnd ? new Date(rows[0].periodEnd) : null;
  return { active: !periodEnd || periodEnd.getTime() > Date.now(), hadRow: true, periodEnd };
}

export async function isEntitled(userId, db = pool) {
  const [dealerRes, compRes, sub] = await Promise.all([
    db.query('select 1 from user_dealerships where user_id = $1 limit 1', [userId]),
    db.query(
      'select 1 from comp_grants where user_id = $1 and (expires_at is null or expires_at > now()) limit 1',
      [userId]
    ),
    activeSubscription(userId, db)
  ]);

  const hasDealership = dealerRes.rows.length > 0;
  const hasComp = compRes.rows.length > 0;
  const { active: subActive, hadRow: hadSubRow, periodEnd } = sub;

  if (!hasDealership) {
    return { entitled: false, reason: 'no_dealership', periodEnd };
  }
  if (!hasComp && !subActive) {
    return { entitled: false, reason: hadSubRow ? 'expired' : 'no_subscription', periodEnd };
  }
  return { entitled: true, reason: 'ok', periodEnd };
}

// Compact ES256 JWS lease the MV3 worker verifies offline with WebCrypto. The caller passes
// the user's linked dealership (its id + exact domains go into the lease); throws if there
// is no dealership or the signing key isn't configured. Claims: { sub, dlr, dom, ent, iat, exp }.
export async function issueLease(user, dealership) {
  if (!dealership || !dealership.id) {
    const e = new Error('cannot issue a lease without a linked dealership');
    e.status = 409;
    throw e;
  }
  const { privateKey, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ dlr: dealership.id, dom: dealership.domains || [], ent: true })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + LEASE_TTL_SECONDS)
    .sign(privateKey);
}
