import '../env.js';
import { SignJWT } from 'jose';
import { pool } from '../db.js';
import { getSigningKey } from './keys.js';

// ENTITLEMENT — billing agent (B). Source of truth for "can this user use the paid product".
// Consumed by /api/me (lease), the AI bearer gate, and the listings gate — all already wired
// to this module, so making isEntitled real opens those gates with no other edits.

export { jwksHandler } from './keys.js';

const LEASE_TTL_SECONDS = 90 * 60;
const OPERATIONAL_ROOFTOP_STATUSES = new Set(['active', 'past_due', 'pending_removal']);

export function isOperationalRooftopStatus(status) {
  return OPERATIONAL_ROOFTOP_STATUSES.has(status);
}

// Entitled = (an active/trialing subscription whose period hasn't ended OR a live comp grant)
// AND the user has linked a supported dealership. The reason lets the extension render the
// right gate step: sign in → link dealership → subscribe → ready.
// → { entitled, reason: 'ok'|'no_subscription'|'expired'|'no_dealership', periodEnd: Date|null }
// Is there a LIVE paid subscription? active/trialing with no period end (or one still in the
// future); a stale 'active' row whose period already passed counts as expired (belt-and-braces).
// Shared by entitlement AND the dealership-switch lock so the two can never drift apart.
// A user can hold SEVERAL active/trialing rows at once (plan change, resubscribe before the
// webhook retires the old row) — order by LIVENESS first, so a stale dated row can never
// shadow a live one (`nulls last` once picked a past-dated 'active' row over a live
// null-periodEnd subscription and wrongly gated a paying user).
export async function activeSubscription(userId, db = pool, { plan = null } = {}) {
  const { rows } = await db.query(
    `select "periodEnd" from "subscription"
      where "referenceId" = $1 and status in ('active', 'trialing')
        and ($2::text is null or plan=$2)
      order by ("periodEnd" is null or "periodEnd" > now()) desc, "periodEnd" desc nulls first
      limit 1`,
    [userId, plan]
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

async function workspaceComp(workspaceId, db) {
  const { rows } = await db.query(
    `select 1 from workspace_comp_grants
      where workspace_id=$1 and revoked_at is null
        and (expires_at is null or expires_at > now())
      limit 1`,
    [workspaceId]
  );
  return rows.length > 0;
}

export function organizationOperationalEntitlement({
  profileStatus,
  graceEndsAt = null,
  subscriptionActive = false,
  hadSubscription = false,
  comp = false,
  now = Date.now()
} = {}) {
  if (!profileStatus) return { paid: false, reason: 'organization_unavailable' };
  if (profileStatus === 'suspended') return { paid: false, reason: 'organization_suspended' };
  if (profileStatus === 'archived') return { paid: false, reason: 'organization_archived' };
  if (profileStatus === 'provisional') return { paid: false, reason: 'claim_approval_required' };
  if (profileStatus === 'past_due') {
    const graceActive = graceEndsAt && new Date(graceEndsAt).getTime() > now;
    return (comp || graceActive)
      ? { paid: true, reason: 'ok' }
      : { paid: false, reason: 'past_due_expired' };
  }
  const paid = comp || subscriptionActive;
  return { paid, reason: paid ? 'ok' : (hadSubscription ? 'expired' : 'no_subscription') };
}

export async function organizationPaidState(organizationId, db = pool) {
  const workspaceId = `organization:${organizationId}`;
  const [subscription, comp, profileResult] = await Promise.all([
    activeSubscription(organizationId, db, { plan: 'dealership_rooftop' }),
    workspaceComp(workspaceId, db),
    db.query(
      `select status, grace_ends_at from organization_profiles where organization_id=$1`,
      [organizationId]
    )
  ]);
  const profile = profileResult.rows[0] || {};
  const operational = organizationOperationalEntitlement({
    profileStatus: profile.status,
    graceEndsAt: profile.grace_ends_at,
    subscriptionActive: subscription.active,
    hadSubscription: subscription.hadRow,
    comp
  });
  return {
    paid: operational.paid,
    reason: operational.reason,
    periodEnd: subscription.periodEnd,
    status: profile.status || null,
    graceEndsAt: profile.grace_ends_at || null
  };
}

function roleCapabilities(workspace) {
  if (!workspace || workspace.type === 'personal') return ['stats:own'];
  const role = workspace.member && workspace.member.role;
  if (role === 'owner') return ['stats:own', 'stats:team', 'team:manage', 'billing:manage'];
  if (role === 'manager') return ['stats:own', 'stats:team', 'team:manage'];
  return ['stats:own'];
}

export async function workspaceEntitlement(userId, workspace, rooftop = null, db = pool) {
  if (!workspace) {
    return { paid: false, canList: false, entitled: false, reason: 'no_workspace', capabilities: [], periodEnd: null };
  }
  if (workspace.type === 'personal') {
    const personal = await isEntitled(userId, db);
    const capabilities = personal.entitled && rooftop
      ? ['list', 'fill', 'ai', 'stats:own']
      : personal.entitled ? ['stats:own'] : [];
    return {
      paid: personal.entitled,
      canList: personal.entitled && Boolean(rooftop),
      entitled: personal.entitled && Boolean(rooftop),
      reason: !personal.entitled ? personal.reason : (rooftop ? 'ok' : 'no_rooftop'),
      capabilities,
      periodEnd: personal.periodEnd,
      role: 'personal',
      seat: Boolean(rooftop)
    };
  }

  if (!workspace.member || workspace.member.status !== 'active') {
    return { paid: false, canList: false, entitled: false, reason: 'membership_inactive', capabilities: [], periodEnd: null };
  }
  const paidState = await organizationPaidState(workspace.organization.id, db);
  if (!paidState.paid) {
    return {
      paid: false,
      canList: false,
      entitled: false,
      reason: paidState.reason,
      capabilities: [],
      periodEnd: paidState.periodEnd,
      role: workspace.member.role,
      seat: false
    };
  }

  const capabilities = roleCapabilities(workspace);
  const seat = Boolean(rooftop && rooftop.hasSeat);
  const rooftopOperational = Boolean(rooftop && isOperationalRooftopStatus(rooftop.status));
  if (seat && rooftopOperational) capabilities.push('list', 'fill', 'ai');
  const canList = capabilities.includes('list');
  return {
    paid: true,
    canList,
    entitled: canList,
    reason: canList ? 'ok' : (!rooftop ? 'no_rooftop' : (seat ? 'rooftop_inactive' : 'no_seat')),
    capabilities,
    periodEnd: paidState.periodEnd,
    role: workspace.member.role,
    seat
  };
}

export async function listingWorkspaceEntitlement(listing, db = pool) {
  if (!listing || !listing.organization_id) return isEntitled(listing.owner_id, db);
  const [paidState, rooftopResult] = await Promise.all([
    organizationPaidState(listing.organization_id, db),
    db.query(
      `select status from organization_rooftops
        where organization_id=$1 and dealership_id=$2`,
      [listing.organization_id, listing.dealership_id]
    )
  ]);
  const rooftopOperational = rooftopResult.rows[0]
    && isOperationalRooftopStatus(rooftopResult.rows[0].status);
  const entitled = paidState.paid && Boolean(rooftopOperational);
  return {
    entitled,
    reason: entitled ? 'ok' : (paidState.paid ? 'rooftop_inactive' : paidState.reason),
    periodEnd: paidState.periodEnd
  };
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

export async function issueWorkspaceLease(user, workspace, rooftop, entitlement) {
  if (!workspace || !rooftop || !rooftop.dealership || !entitlement || !entitlement.canList) {
    const err = new Error('cannot issue a lease without an entitled workspace rooftop');
    err.status = 409;
    throw err;
  }
  const { privateKey, kid } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const organizationId = workspace.type === 'organization' ? workspace.organization.id : null;
  return new SignJWT({
    ver: 2,
    wsp: workspace.id,
    wty: workspace.type,
    org: organizationId,
    dlr: rooftop.dealership.id,
    dom: rooftop.dealership.domains || [],
    cap: entitlement.capabilities,
    role: entitlement.role,
    seat: entitlement.seat,
    ent: true
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + LEASE_TTL_SECONDS)
    .sign(privateKey);
}
