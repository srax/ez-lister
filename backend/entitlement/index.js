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
export async function isEntitled(userId, db = pool) {
  const [dealerRes, compRes, subRes] = await Promise.all([
    db.query('select 1 from user_dealerships where user_id = $1 limit 1', [userId]),
    db.query(
      'select 1 from comp_grants where user_id = $1 and (expires_at is null or expires_at > now()) limit 1',
      [userId]
    ),
    db.query(
      `select "periodEnd" from "subscription"
        where "referenceId" = $1 and status in ('active', 'trialing')
        order by "periodEnd" desc nulls last
        limit 1`,
      [userId]
    )
  ]);

  const hasDealership = dealerRes.rows.length > 0;
  const hasComp = compRes.rows.length > 0;

  let periodEnd = null;
  let subActive = false;
  const hadSubRow = subRes.rows.length > 0;
  if (hadSubRow) {
    periodEnd = subRes.rows[0].periodEnd ? new Date(subRes.rows[0].periodEnd) : null;
    // active/trialing with no period end (or one still in the future) counts as live; a stale
    // 'active' row whose period already passed is treated as expired (belt-and-braces).
    subActive = !periodEnd || periodEnd.getTime() > Date.now();
  }

  if (!hasComp && !subActive) {
    return { entitled: false, reason: hadSubRow ? 'expired' : 'no_subscription', periodEnd };
  }
  if (!hasDealership) {
    return { entitled: false, reason: 'no_dealership', periodEnd };
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
