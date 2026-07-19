import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { requireMembership, requireOwner } from './organization-authz.js';
import { createOrganizationNotification, recordOrganizationAudit } from './organization-audit.js';

const OPEN_CLAIM_STATUSES = new Set(['pending', 'evidence_requested']);
const RESERVED_CLAIM_STATUSES = new Set(['approved', 'checkout_pending', 'active']);
const HOLD_CLAIM_STATUSES = new Set(['disputed', 'suspended']);
const RESERVATION_HOURS = 72;

function domainError(message, status, reason) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function cleanName(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function slugPart(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function publicClaim(row) {
  return {
    id: row.id,
    claimGroupId: row.claim_group_id,
    dealershipId: row.dealership_id,
    dealershipName: row.dealership_name || null,
    organizationId: row.organization_id || null,
    organizationName: row.organization_name || null,
    status: row.status,
    attestedAt: row.attested_at,
    reservationExpiresAt: row.reservation_expires_at || null,
    reviewedAt: row.reviewed_at || null,
    reviewReason: row.review_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getClaimRow(claimId, db, { lock = false } = {}) {
  const { rows } = await db.query(
    `select c.*, d.name as dealership_name, d.status as dealership_status
       from dealership_claims c
       join dealerships d on d.id = c.dealership_id
      where c.id = $1${lock ? ' for update of c' : ''}`,
    [claimId]
  );
  return rows[0] || null;
}

export async function createClaims(user, {
  dealershipIds = [],
  organizationId = null,
  organizationName = null,
  attested = false
} = {}, db = pool) {
  const uniqueDealers = [...new Set((Array.isArray(dealershipIds) ? dealershipIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))];
  if (attested !== true) throw domainError('authority attestation is required', 400, 'attestation_required');
  if (!uniqueDealers.length || uniqueDealers.length > 25) {
    throw domainError('choose between 1 and 25 dealerships', 400, 'invalid_rooftops');
  }

  let existingOrganization = null;
  if (organizationId) {
    existingOrganization = await requireMembership(user.id, organizationId, db);
    requireOwner(existingOrganization);
  } else if (!cleanName(organizationName)) {
    throw domainError('organization name is required', 400, 'organization_name_required');
  }

  return withTransaction(async (tx) => {
    const { rows: dealers } = await tx.query(
      `select id, name, status from dealerships where id = any($1) order by id for update`,
      [uniqueDealers]
    );
    if (dealers.length !== uniqueDealers.length || dealers.some((d) => d.status !== 'supported')) {
      throw domainError('every dealership must be supported before it can be claimed', 409, 'unsupported_dealership');
    }

    const { rows: occupied } = await tx.query(
      `select r.dealership_id, r.organization_id, r.status
         from organization_rooftops r
        where r.dealership_id = any($1)
          and r.status in ('reserved','active','past_due','suspended','pending_removal')`,
      [uniqueDealers]
    );
    if (occupied.length) {
      throw domainError('one or more dealerships are already claimed', 409, 'dealership_claimed');
    }

    const { rows: existing } = await tx.query(
      `select * from dealership_claims
        where user_id = $1 and dealership_id = any($2)
          and status in ('pending','evidence_requested')`,
      [user.id, uniqueDealers]
    );
    const byDealer = new Map(existing.map((row) => [row.dealership_id, row]));
    const claimGroupId = existing[0] ? existing[0].claim_group_id : crypto.randomUUID();
    const created = [];

    for (const dealer of dealers) {
      const duplicate = byDealer.get(dealer.id);
      if (duplicate) {
        created.push({ ...duplicate, dealership_name: dealer.name });
        continue;
      }
      const id = crypto.randomUUID();
      const { rows } = await tx.query(
        `insert into dealership_claims (
           id, claim_group_id, user_id, dealership_id, organization_id,
           organization_name, status, attested_at
         ) values ($1,$2,$3,$4,$5,$6,'pending',now())
         returning *`,
        [
          id, claimGroupId, user.id, dealer.id, organizationId,
          organizationId ? null : cleanName(organizationName)
        ]
      );
      const row = { ...rows[0], dealership_name: dealer.name };
      created.push(row);
      await recordOrganizationAudit({
        organizationId,
        dealershipId: dealer.id,
        actorUserId: user.id,
        action: 'claim.created',
        targetType: 'claim',
        targetId: id,
        data: { claimGroupId, organizationName: cleanName(organizationName) || null }
      }, tx);
    }
    return created.map(publicClaim);
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function listClaimsForUser(userId, db = pool) {
  const { rows } = await db.query(
    `select c.*, d.name as dealership_name
       from dealership_claims c
       join dealerships d on d.id = c.dealership_id
      where c.user_id = $1
      order by c.created_at desc, c.id`,
    [userId]
  );
  return rows.map(publicClaim);
}

export async function getClaimForUser(userId, claimId, db = pool) {
  const row = await getClaimRow(claimId, db);
  if (!row || row.user_id !== userId) throw domainError('claim not found', 404, 'not_found');
  return publicClaim(row);
}

async function createOrganizationForClaim(claim, tx) {
  const organizationId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const name = cleanName(claim.organization_name, claim.dealership_name);
  const slug = `${slugPart(name) || 'dealership'}-${organizationId.slice(0, 8)}`;
  await tx.query(
    `insert into "organization" (id, name, slug, "createdAt", metadata)
     values ($1,$2,$3,now(),$4)`,
    [organizationId, name, slug, JSON.stringify({ createdBy: 'verified_claim' })]
  );
  await tx.query(
    `insert into "member" (id, "organizationId", "userId", role, "createdAt")
     values ($1,$2,$3,'owner',now())`,
    [memberId, organizationId, claim.user_id]
  );
  await tx.query(
    `insert into organization_member_profiles (
       member_id, organization_id, user_id, role, all_rooftops, status
     ) values ($1,$2,$3,'owner',false,'active')`,
    [memberId, organizationId, claim.user_id]
  );
  await tx.query(
    `insert into organization_profiles (organization_id, primary_owner_member_id, status)
     values ($1,$2,'provisional')`,
    [organizationId, memberId]
  );
  await tx.query(
    `insert into workspaces (id, type, organization_id, status)
     values ($1,'organization',$2,'provisional')`,
    [`organization:${organizationId}`, organizationId]
  );
  return { organizationId, memberId, name };
}

export async function approveClaim(claimId, {
  actor = 'admin',
  reason,
  includedSeats = 10
} = {}, db = pool) {
  const cleanReason = cleanName(reason);
  if (!cleanReason) throw domainError('approval reason is required', 400, 'reason_required');
  const seats = Number(includedSeats);
  if (!Number.isInteger(seats) || seats < 0 || seats > 500) {
    throw domainError('includedSeats must be between 0 and 500', 400, 'invalid_capacity');
  }

  const result = await withTransaction(async (tx) => {
    const claim = await getClaimRow(claimId, tx, { lock: true });
    if (!claim) throw domainError('claim not found', 404, 'not_found');
    if (RESERVED_CLAIM_STATUSES.has(claim.status)) return publicClaim(claim);
    if (!OPEN_CLAIM_STATUSES.has(claim.status)) {
      throw domainError(`claim cannot be approved from ${claim.status}`, 409, 'invalid_claim_state');
    }
    // All rooftops submitted together must resolve to one organization even if two admin
    // approvals arrive concurrently. The claim row lock alone only serializes one rooftop;
    // this transaction-scoped group lock serializes organization creation for the bundle.
    await tx.query(
      'select pg_advisory_xact_lock(hashtextextended($1,0))',
      [claim.claim_group_id]
    );
    if (claim.dealership_status !== 'supported') {
      throw domainError('dealership is no longer supported', 409, 'unsupported_dealership');
    }

    const { rows: occupied } = await tx.query(
      `select organization_id from organization_rooftops
        where dealership_id = $1
          and status in ('reserved','active','past_due','suspended','pending_removal')
        for update`,
      [claim.dealership_id]
    );
    if (occupied.length && occupied[0].organization_id !== claim.organization_id) {
      const { rows } = await tx.query(
        `update dealership_claims set status='conflict', reviewed_by=$2, reviewed_at=now(),
           review_reason=$3, updated_at=now() where id=$1 returning *`,
        [claim.id, actor, cleanReason]
      );
      await recordOrganizationAudit({
        organizationId: claim.organization_id,
        dealershipId: claim.dealership_id,
        actorUserId: actor,
        action: 'claim.conflict',
        targetType: 'claim',
        targetId: claim.id,
        reason: cleanReason
      }, tx);
      return { conflict: publicClaim({ ...rows[0], dealership_name: claim.dealership_name }) };
    }

    let organizationId = claim.organization_id;
    let organizationName = claim.organization_name;
    if (!organizationId) {
      const { rows: sibling } = await tx.query(
        `select organization_id from dealership_claims
          where claim_group_id = $1 and organization_id is not null
          order by reviewed_at nulls last limit 1`,
        [claim.claim_group_id]
      );
      organizationId = sibling[0] && sibling[0].organization_id;
    }
    if (!organizationId) {
      const created = await createOrganizationForClaim(claim, tx);
      organizationId = created.organizationId;
      organizationName = created.name;
    } else {
      const member = await requireMembership(claim.user_id, organizationId, tx);
      requireOwner(member);
      const { rows } = await tx.query('select name from "organization" where id = $1', [organizationId]);
      if (!rows.length) throw domainError('organization not found', 404, 'not_found');
      organizationName = rows[0].name;
    }

    const expiresAt = new Date(Date.now() + RESERVATION_HOURS * 60 * 60 * 1000).toISOString();
    await tx.query(
      `insert into organization_rooftops (
         organization_id, dealership_id, status, included_seats, reservation_expires_at
       ) values ($1,$2,'reserved',$3,$4)
       on conflict (organization_id, dealership_id) do update set
         status='reserved', included_seats=excluded.included_seats,
         reservation_expires_at=excluded.reservation_expires_at, updated_at=now()`,
      [organizationId, claim.dealership_id, seats, expiresAt]
    );
    const { rows } = await tx.query(
      `update dealership_claims set
         organization_id=$2, organization_name=$3, status='approved',
         reservation_expires_at=$4, reviewed_by=$5, reviewed_at=now(),
         review_reason=$6, updated_at=now()
       where id=$1 returning *`,
      [claim.id, organizationId, organizationName, expiresAt, actor, cleanReason]
    );
    await recordOrganizationAudit({
      organizationId,
      dealershipId: claim.dealership_id,
      actorUserId: actor,
      action: 'claim.approved',
      targetType: 'claim',
      targetId: claim.id,
      reason: cleanReason,
      data: { reservationExpiresAt: expiresAt, includedSeats: seats }
    }, tx);
    await createOrganizationNotification({
      userId: claim.user_id,
      organizationId,
      type: 'claim_approved',
      data: { claimId: claim.id, dealershipId: claim.dealership_id, reservationExpiresAt: expiresAt }
    }, tx);
    return publicClaim({ ...rows[0], dealership_name: claim.dealership_name });
  }, { db, isolation: 'serializable', retries: 2 });
  if (result.conflict) {
    const err = domainError('dealership was claimed by another organization', 409, 'dealership_claimed');
    err.claim = result.conflict;
    throw err;
  }
  return result;
}

export async function decideClaim(claimId, {
  status,
  actor = 'admin',
  reason
} = {}, db = pool) {
  if (!['evidence_requested', 'rejected', 'disputed', 'suspended'].includes(status)) {
    throw domainError('unsupported claim decision', 400, 'invalid_claim_state');
  }
  const cleanReason = cleanName(reason);
  if (!cleanReason) throw domainError('decision reason is required', 400, 'reason_required');
  return withTransaction(async (tx) => {
    const claim = await getClaimRow(claimId, tx, { lock: true });
    if (!claim) throw domainError('claim not found', 404, 'not_found');
    if (claim.status === status) return publicClaim(claim);
    const holding = HOLD_CLAIM_STATUSES.has(status);
    const allowed = (!holding && OPEN_CLAIM_STATUSES.has(claim.status))
      || (holding && (OPEN_CLAIM_STATUSES.has(claim.status) || RESERVED_CLAIM_STATUSES.has(claim.status)
        || (HOLD_CLAIM_STATUSES.has(claim.status) && Boolean(claim.hold_from_status))));
    if (!allowed) throw domainError(`claim cannot transition from ${claim.status}`, 409, 'invalid_claim_state');
    let rooftopStatus = claim.hold_rooftop_status || null;
    if (holding && claim.organization_id) {
      const { rows: rooftops } = await tx.query(
        `select status from organization_rooftops
          where organization_id=$1 and dealership_id=$2 for update`,
        [claim.organization_id, claim.dealership_id]
      );
      if (rooftops[0] && !rooftopStatus) rooftopStatus = rooftops[0].status;
    }
    const { rows } = await tx.query(
      `update dealership_claims set status=$2, reviewed_by=$3, reviewed_at=now(),
         review_reason=$4,
         hold_from_status=case when $5 then coalesce(hold_from_status,$6) else hold_from_status end,
         hold_rooftop_status=case when $5 then coalesce(hold_rooftop_status,$7) else hold_rooftop_status end,
         updated_at=now() where id=$1 returning *`,
      [claim.id, status, actor, cleanReason, holding, claim.status, rooftopStatus]
    );
    if (holding && claim.organization_id) {
      await tx.query(
        `update organization_rooftops set status='suspended', updated_at=now()
          where organization_id=$1 and dealership_id=$2 and status<>'archived'`,
        [claim.organization_id, claim.dealership_id]
      );
    }
    await recordOrganizationAudit({
      organizationId: claim.organization_id,
      dealershipId: claim.dealership_id,
      actorUserId: actor,
      action: `claim.${status}`,
      targetType: 'claim',
      targetId: claim.id,
      reason: cleanReason
    }, tx);
    await createOrganizationNotification({
      userId: claim.user_id,
      organizationId: claim.organization_id,
      type: `claim_${status}`,
      data: { claimId: claim.id, reason: cleanReason }
    }, tx);
    return publicClaim({ ...rows[0], dealership_name: claim.dealership_name });
  }, { db });
}

export async function restoreClaimHold(claimId, {
  actor = 'admin',
  reason
} = {}, db = pool) {
  const cleanReason = cleanName(reason);
  if (!cleanReason) throw domainError('restore reason is required', 400, 'reason_required');
  return withTransaction(async (tx) => {
    const claim = await getClaimRow(claimId, tx, { lock: true });
    if (!claim) throw domainError('claim not found', 404, 'not_found');
    if (!HOLD_CLAIM_STATUSES.has(claim.status)) {
      throw domainError(`claim is not on hold (${claim.status})`, 409, 'invalid_claim_state');
    }
    const targetStatus = claim.hold_from_status;
    if (!targetStatus || !(OPEN_CLAIM_STATUSES.has(targetStatus) || RESERVED_CLAIM_STATUSES.has(targetStatus))) {
      throw domainError('claim hold has no restorable prior state', 409, 'missing_hold_state');
    }
    if (['approved', 'checkout_pending'].includes(targetStatus)
        && (!claim.reservation_expires_at || new Date(claim.reservation_expires_at).getTime() <= Date.now())) {
      throw domainError('the claim reservation expired while on hold', 409, 'claim_reservation_expired');
    }

    if (claim.organization_id && claim.hold_rooftop_status) {
      const allowedRooftopStates = new Set(['reserved', 'active', 'past_due', 'suspended', 'pending_removal']);
      if (!allowedRooftopStates.has(claim.hold_rooftop_status)) {
        throw domainError('claim rooftop can no longer be restored', 409, 'invalid_rooftop_state');
      }
      const { rowCount } = await tx.query(
        `update organization_rooftops set status=$3,updated_at=now()
          where organization_id=$1 and dealership_id=$2 and status='suspended'`,
        [claim.organization_id, claim.dealership_id, claim.hold_rooftop_status]
      );
      if (!rowCount) throw domainError('claim rooftop can no longer be restored', 409, 'invalid_rooftop_state');
    }
    const { rows } = await tx.query(
      `update dealership_claims set status=$2,reviewed_by=$3,reviewed_at=now(),
         review_reason=$4,hold_from_status=null,hold_rooftop_status=null,updated_at=now()
        where id=$1 returning *`,
      [claim.id, targetStatus, actor, cleanReason]
    );
    await recordOrganizationAudit({
      organizationId: claim.organization_id,
      dealershipId: claim.dealership_id,
      actorUserId: actor,
      action: 'claim.hold_restored',
      targetType: 'claim',
      targetId: claim.id,
      reason: cleanReason,
      data: { from: claim.status, restoredTo: targetStatus, rooftopStatus: claim.hold_rooftop_status }
    }, tx);
    await createOrganizationNotification({
      userId: claim.user_id,
      organizationId: claim.organization_id,
      type: 'claim_hold_restored',
      data: { claimId: claim.id, dealershipId: claim.dealership_id }
    }, tx);
    return publicClaim({ ...rows[0], dealership_name: claim.dealership_name });
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function recordClaimEvidence(claimId, {
  type,
  summary = null,
  actor = 'admin'
} = {}, db = pool) {
  const cleanType = cleanName(type).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60);
  if (!cleanType) throw domainError('evidence type is required', 400, 'evidence_required');
  const claim = await getClaimRow(claimId, db);
  if (!claim) throw domainError('claim not found', 404, 'not_found');
  const id = crypto.randomUUID();
  await db.query(
    `insert into claim_evidence (id, claim_id, type, summary, recorded_by)
     values ($1,$2,$3,$4,$5)`,
    [id, claimId, cleanType, cleanName(summary).slice(0, 1000) || null, actor]
  );
  await recordOrganizationAudit({
    organizationId: claim.organization_id,
    dealershipId: claim.dealership_id,
    actorUserId: actor,
    action: 'claim.evidence_recorded',
    targetType: 'claim_evidence',
    targetId: id,
    data: { type: cleanType }
  }, db);
  return { id };
}

export async function markClaimCheckoutPending(organizationId, db = pool) {
  const { rowCount } = await db.query(
    `update dealership_claims set status='checkout_pending', updated_at=now()
      where organization_id=$1 and status='approved'
        and reservation_expires_at > now()`,
    [organizationId]
  );
  return rowCount;
}

export async function activateOrganizationClaims(
  organizationId,
  db = pool,
  { paidRooftopQuantity = null } = {}
) {
  const paidQuantity = paidRooftopQuantity == null
    ? null
    : Math.max(0, Math.floor(Number(paidRooftopQuantity)));
  if (paidQuantity != null && !Number.isFinite(paidQuantity)) {
    throw domainError('paid rooftop quantity is invalid', 400, 'invalid_rooftop_quantity');
  }
  return withTransaction(async (tx) => {
    const { rows: organizationRows } = await tx.query(
      `select id from "organization" where id=$1 for update`,
      [organizationId]
    );
    if (!organizationRows.length) throw domainError('organization not found', 404, 'not_found');
    // Claim verification and billing state are separate. A Stripe recovery may reactivate a
    // billing-suspended rooftop only while its claim is still active; it must never revive an
    // expired reservation or an administratively suspended/disputed claim.
    const { rows: activeClaimRows } = await tx.query(
      `select distinct c.dealership_id,r.status,r.removal_effective_at,
              r.activated_at,c.created_at from dealership_claims c
       join organization_rooftops r on r.organization_id=c.organization_id
        and r.dealership_id=c.dealership_id
        where c.organization_id=$1 and c.status='active'
          and r.status in ('active','past_due','suspended','pending_removal')
        order by r.activated_at nulls last,c.created_at,c.dealership_id`,
      [organizationId]
    );
    const protectedPendingRemovals = activeClaimRows.filter((claim) =>
      claim.status === 'pending_removal'
        && claim.removal_effective_at
        && new Date(claim.removal_effective_at).getTime() > Date.now()
    );
    const billableActiveClaims = activeClaimRows.filter((claim) =>
      !protectedPendingRemovals.some((pending) => pending.dealership_id === claim.dealership_id)
    );
    const activeCount = billableActiveClaims.length;
    const operationalActiveClaims = paidQuantity == null
      ? billableActiveClaims
      : billableActiveClaims.slice(0, paidQuantity);
    const excessActiveClaims = paidQuantity == null
      ? []
      : billableActiveClaims.slice(paidQuantity);
    const availablePaidSlots = paidQuantity == null
      ? 10000
      : Math.max(0, paidQuantity - operationalActiveClaims.length);
    const { rows: candidates } = await tx.query(
      `select id from dealership_claims
        where organization_id=$1 and status in ('approved','checkout_pending')
          and reservation_expires_at > now()
        order by reviewed_at nulls last,created_at,id
        limit $2 for update`,
      [organizationId, availablePaidSlots]
    );
    const { rows: claims } = candidates.length
      ? await tx.query(
          `update dealership_claims set status='active',reservation_expires_at=null,updated_at=now()
            where id=any($1) returning *`,
          [candidates.map((claim) => claim.id)]
        )
      : { rows: [] };
    const dealershipIds = [...new Set([
      ...claims.map((claim) => claim.dealership_id),
      ...operationalActiveClaims.map((claim) => claim.dealership_id),
      ...protectedPendingRemovals.map((claim) => claim.dealership_id)
    ])];
    if (excessActiveClaims.length) {
      await tx.query(
        `update organization_rooftops set status='suspended',updated_at=now()
          where organization_id=$1 and dealership_id=any($2)
            and status in ('active','past_due','pending_removal')`,
        [organizationId, excessActiveClaims.map((claim) => claim.dealership_id)]
      );
    }
    if (!dealershipIds.length) {
      if (paidQuantity == null) {
        throw domainError('no live approved rooftop reservation', 409, 'claim_reservation_expired');
      }
      await tx.query(
        `update organization_profiles set status='suspended',grace_ends_at=null,
           suspended_at=coalesce(suspended_at,now()),updated_at=now()
          where organization_id=$1`,
        [organizationId]
      );
      await tx.query(
        `update workspaces set status='suspended',updated_at=now()
          where organization_id=$1`,
        [organizationId]
      );
      return {
        activated: 0,
        operationalRooftops: 0,
        paidRooftopQuantity: paidQuantity,
        quantityMismatch: activeCount > paidQuantity,
        suspendedForQuantity: excessActiveClaims.length,
        pendingRemovalRooftops: protectedPendingRemovals.length
      };
    }
    await tx.query(
      `update organization_rooftops set status='active', reservation_expires_at=null,
         activated_at=coalesce(activated_at,now()), updated_at=now()
        where organization_id=$1 and dealership_id=any($2)
          and status in ('reserved','past_due','suspended')`,
      [organizationId, dealershipIds]
    );
    await tx.query(
      `update organization_profiles set status='active', grace_ends_at=null, updated_at=now()
        where organization_id=$1`,
      [organizationId]
    );
    await tx.query(
      `update workspaces set status='active', updated_at=now()
        where organization_id=$1`,
      [organizationId]
    );
    for (const claim of claims) {
      await recordOrganizationAudit({
        organizationId,
        dealershipId: claim.dealership_id,
        actorUserId: 'stripe:webhook',
        action: 'claim.activated',
        targetType: 'claim',
        targetId: claim.id
      }, tx);
    }
    return {
      activated: claims.length,
      operationalRooftops: dealershipIds.length,
      paidRooftopQuantity: paidQuantity,
      quantityMismatch: paidQuantity != null && activeCount > paidQuantity,
      suspendedForQuantity: excessActiveClaims.length,
      pendingRemovalRooftops: protectedPendingRemovals.length
    };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function expireClaimReservations(db = pool, now = new Date()) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `update dealership_claims set status='expired', updated_at=now()
        where status in ('approved','checkout_pending')
          and reservation_expires_at <= $1
        returning id, organization_id, dealership_id, user_id`,
      [now.toISOString()]
    );
    for (const claim of rows) {
      await tx.query(
        `update organization_rooftops set status='archived', archived_at=now(), updated_at=now()
          where organization_id=$1 and dealership_id=$2 and status='reserved'`,
        [claim.organization_id, claim.dealership_id]
      );
      await recordOrganizationAudit({
        organizationId: claim.organization_id,
        dealershipId: claim.dealership_id,
        actorUserId: 'system:claims',
        action: 'claim.expired',
        targetType: 'claim',
        targetId: claim.id
      }, tx);
      await createOrganizationNotification({
        userId: claim.user_id,
        organizationId: claim.organization_id,
        type: 'claim_expired',
        data: { claimId: claim.id, dealershipId: claim.dealership_id }
      }, tx);
    }
    const organizationIds = [...new Set(rows.map((row) => row.organization_id).filter(Boolean))];
    for (const organizationId of organizationIds) {
      const { rows: live } = await tx.query(
        `select 1 from organization_rooftops
          where organization_id=$1
            and status in ('reserved','active','past_due','suspended','pending_removal')
          limit 1`,
        [organizationId]
      );
      if (!live.length) {
        await tx.query(
          `update organization_profiles set status='archived', archived_at=now(), updated_at=now()
            where organization_id=$1 and status='provisional'`,
          [organizationId]
        );
        await tx.query(
          `update workspaces set status='archived', updated_at=now()
            where organization_id=$1 and status='provisional'`,
          [organizationId]
        );
      }
    }
    return rows.length;
  }, { db });
}

export { publicClaim };
