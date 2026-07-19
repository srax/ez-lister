import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import {
  OrganizationAccessError,
  requireMembership,
  requireOwner,
  requireRooftopAccess,
  requireTeamManagement
} from './organization-authz.js';
import { createOrganizationNotification, recordOrganizationAudit } from './organization-audit.js';
import { notifyOrganizationInvitation } from './email.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function domainError(message, status = 400, reason = 'invalid_request') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function publicMember(row) {
  return {
    id: row.member_id || row.id,
    userId: row.user_id,
    name: row.user_name || null,
    email: row.user_email || null,
    role: row.role,
    allRooftops: Boolean(row.all_rooftops),
    status: row.status,
    createdAt: row.created_at || null,
    rooftops: row.rooftops || []
  };
}

export function availableCapacity({ includedSeats = 0, extraSeats = 0, assigned = 0, reserved = 0 }) {
  return Math.max(0, Number(includedSeats) + Number(extraSeats) - Number(assigned) - Number(reserved));
}

async function lockRooftop(organizationId, dealershipId, db) {
  const { rows } = await db.query(
    `select * from organization_rooftops
      where organization_id=$1 and dealership_id=$2
      for update`,
    [organizationId, dealershipId]
  );
  const rooftop = rows[0];
  if (!rooftop || !['reserved', 'active', 'past_due', 'suspended', 'pending_removal'].includes(rooftop.status)) {
    throw domainError('organization rooftop not found', 404, 'wrong_rooftop');
  }
  return rooftop;
}

async function capacitySnapshotLocked(organizationId, dealershipId, db) {
  const rooftop = await lockRooftop(organizationId, dealershipId, db);
  // A transaction client executes one query at a time. Keep these sequential so this remains
  // valid under pg 9, which removes the deprecated concurrent client.query behavior.
  const assignments = await db.query(
    `select count(*)::int as count from seat_assignments
      where organization_id=$1 and dealership_id=$2 and released_at is null`,
    [organizationId, dealershipId]
  );
  const reservations = await db.query(
    `select count(*)::int as count from seat_reservations
      where organization_id=$1 and dealership_id=$2 and released_at is null and expires_at > now()`,
    [organizationId, dealershipId]
  );
  const snapshot = {
    includedSeats: rooftop.included_seats,
    extraSeats: rooftop.extra_seats,
    assigned: assignments.rows[0].count,
    reserved: reservations.rows[0].count
  };
  return { ...snapshot, available: availableCapacity(snapshot), rooftop };
}

export async function getCapacity(organizationId, dealershipId, db = pool) {
  return withTransaction(
    (tx) => capacitySnapshotLocked(organizationId, dealershipId, tx),
    { db, isolation: 'repeatable read' }
  );
}

async function getTargetMember(organizationId, memberId, db, { lock = false } = {}) {
  const { rows } = await db.query(
    `select m.id as member_id, m."organizationId" as organization_id, m."userId" as user_id,
            coalesce(mp.role, case when m.role='owner' then 'owner' else 'salesperson' end) as role,
            coalesce(mp.all_rooftops,false) as all_rooftops,
            coalesce(mp.status,'active') as status
       from "member" m
       left join organization_member_profiles mp on mp.member_id=m.id
      where m.id=$1 and m."organizationId"=$2${lock ? ' for update of m' : ''}`,
    [memberId, organizationId]
  );
  return rows[0] || null;
}

async function ensureTargetRooftopAccess(member, dealershipId, db) {
  if (member.role === 'owner' || member.all_rooftops) return;
  const { rows } = await db.query(
    `select 1 from member_rooftop_access
      where member_id=$1 and organization_id=$2 and dealership_id=$3 and revoked_at is null`,
    [member.member_id, member.organization_id, dealershipId]
  );
  if (!rows.length) throw domainError('member is not assigned to this rooftop', 409, 'member_wrong_rooftop');
}

async function assignSeatLocked({ organizationId, dealershipId, memberId, actorUserId }, db) {
  const target = await getTargetMember(organizationId, memberId, db, { lock: true });
  if (!target || target.status !== 'active') throw domainError('active member not found', 404, 'member_not_found');
  await ensureTargetRooftopAccess(target, dealershipId, db);
  const { rows: existing } = await db.query(
    `select id from seat_assignments
      where organization_id=$1 and dealership_id=$2 and member_id=$3 and released_at is null`,
    [organizationId, dealershipId, memberId]
  );
  if (existing.length) return { id: existing[0].id, assigned: false, target };
  const capacity = await capacitySnapshotLocked(organizationId, dealershipId, db);
  if (capacity.available < 1) throw domainError('no listing seats available', 409, 'no_capacity');
  const id = crypto.randomUUID();
  await db.query(
    `insert into seat_assignments (id, organization_id, dealership_id, member_id, assigned_by)
     values ($1,$2,$3,$4,$5)`,
    [id, organizationId, dealershipId, memberId, actorUserId]
  );
  return { id, assigned: true, target };
}

export async function assignSeat(actorUserId, organizationId, dealershipId, memberId, db = pool) {
  return withTransaction(async (tx) => {
    const actor = await requireMembership(actorUserId, organizationId, tx);
    const target = await getTargetMember(organizationId, memberId, tx);
    if (!target) throw domainError('member not found', 404, 'member_not_found');
    await requireTeamManagement(actor, dealershipId, target.role, tx);
    const result = await assignSeatLocked({ organizationId, dealershipId, memberId, actorUserId }, tx);
    if (result.assigned) {
      await recordOrganizationAudit({
        organizationId,
        dealershipId,
        actorUserId,
        action: 'seat.assigned',
        targetType: 'member',
        targetId: memberId
      }, tx);
      await createOrganizationNotification({
        userId: result.target.user_id,
        organizationId,
        type: 'seat_assigned',
        data: { dealershipId }
      }, tx);
    }
    return { seatId: result.id, assigned: result.assigned };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function releaseSeat(actorUserId, organizationId, dealershipId, memberId, db = pool) {
  const result = await withTransaction(async (tx) => {
    const actor = await requireMembership(actorUserId, organizationId, tx);
    const target = await getTargetMember(organizationId, memberId, tx);
    if (!target) throw domainError('member not found', 404, 'member_not_found');
    await requireTeamManagement(actor, dealershipId, target.role, tx);
    const { rowCount } = await tx.query(
      `update seat_assignments set released_at=now(), released_by=$4
        where organization_id=$1 and dealership_id=$2 and member_id=$3 and released_at is null`,
      [organizationId, dealershipId, memberId, actorUserId]
    );
    if (rowCount) {
      await recordOrganizationAudit({
        organizationId,
        dealershipId,
        actorUserId,
        action: 'seat.released',
        targetType: 'member',
        targetId: memberId
      }, tx);
      await createOrganizationNotification({
        userId: target.user_id,
        organizationId,
        type: 'seat_released',
        data: { dealershipId }
      }, tx);
    }
    return { released: rowCount > 0 };
  }, { db, isolation: 'serializable', retries: 2 });
  if (result.released) await activateWaitingRequests(organizationId, dealershipId, db);
  return result;
}

// The organization package includes rooftop-scoped listing seats, while owner/manager access
// itself consumes none. Persist the owner's one-time onboarding choice so dashboard-only owners
// are not prompted again on every device. A later manual seat change remains available in Team.
export async function setOwnerListingPreference(actorUserId, organizationId, {
  willList
} = {}, db = pool) {
  if (typeof willList !== 'boolean') {
    throw domainError('willList must be true or false', 400, 'invalid_preference');
  }
  return withTransaction(async (tx) => {
    const owner = await requireMembership(actorUserId, organizationId, tx);
    requireOwner(owner);
    await tx.query('select id from "organization" where id=$1 for update', [organizationId]);
    const { rows: profileRows } = await tx.query(
      `select listing_preference from organization_member_profiles
        where member_id=$1 for update`,
      [owner.member_id]
    );
    if (!profileRows.length) throw domainError('owner profile not found', 404, 'member_not_found');

    const preference = willList ? 'listing' : 'dashboard';
    const { rows: rooftops } = await tx.query(
      `select dealership_id from organization_rooftops
        where organization_id=$1 and status in ('active','past_due','pending_removal')
        order by dealership_id for update`,
      [organizationId]
    );
    if (willList && !rooftops.length) {
      throw domainError('no active rooftop is available for listing', 409, 'no_active_rooftop');
    }

    const changedDealershipIds = [];
    if (willList) {
      for (const rooftop of rooftops) {
        const result = await assignSeatLocked({
          organizationId,
          dealershipId: rooftop.dealership_id,
          memberId: owner.member_id,
          actorUserId
        }, tx);
        if (result.assigned) changedDealershipIds.push(rooftop.dealership_id);
      }
    } else {
      const { rows: released } = await tx.query(
        `update seat_assignments set released_at=now(),released_by=$3
          where organization_id=$1 and member_id=$2 and released_at is null
          returning dealership_id`,
        [organizationId, owner.member_id, actorUserId]
      );
      changedDealershipIds.push(...released.map((row) => row.dealership_id));
    }

    await tx.query(
      `update organization_member_profiles
          set listing_preference=$2,listing_preference_at=now(),updated_at=now()
        where member_id=$1`,
      [owner.member_id, preference]
    );
    await recordOrganizationAudit({
      organizationId,
      actorUserId,
      action: 'owner.listing_preference_set',
      targetType: 'member',
      targetId: owner.member_id,
      data: {
        preference,
        activeRooftops: rooftops.map((row) => row.dealership_id),
        changedDealershipIds
      }
    }, tx);
    return {
      preference,
      memberId: owner.member_id,
      dealershipIds: rooftops.map((row) => row.dealership_id),
      changedDealershipIds
    };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function createAccessRequest(user, {
  dealershipId,
  requestedRole = 'salesperson'
} = {}, db = pool) {
  if (!['manager', 'salesperson'].includes(requestedRole)) {
    throw domainError('invalid requested role', 400, 'invalid_role');
  }
  return withTransaction(async (tx) => {
    const { rows: rooftopRows } = await tx.query(
      `select r.organization_id
         from organization_rooftops r
        where r.dealership_id=$1
          and r.status in ('reserved','active','past_due','suspended','pending_removal')
        for update`,
      [dealershipId]
    );
    if (!rooftopRows.length) throw domainError('dealership is not claimed by a team', 409, 'dealership_unclaimed');
    const organizationId = rooftopRows[0].organization_id;
    const existingMember = await requireMembership(user.id, organizationId, tx).catch((err) => {
      if (err instanceof OrganizationAccessError) return null;
      throw err;
    });
    if (existingMember) throw domainError('you already belong to this organization', 409, 'already_member');
    const { rows: open } = await tx.query(
      `select * from organization_access_requests
        where organization_id=$1 and dealership_id=$2 and user_id=$3
          and status in ('pending','approved_awaiting_capacity')
        limit 1`,
      [organizationId, dealershipId, user.id]
    );
    if (open.length) return open[0];
    const id = crypto.randomUUID();
    const { rows } = await tx.query(
      `insert into organization_access_requests (
         id, organization_id, dealership_id, user_id, email, requested_role, status
       ) values ($1,$2,$3,$4,$5,$6,'pending') returning *`,
      [id, organizationId, dealershipId, user.id, normalizeEmail(user.email), requestedRole]
    );
    await recordOrganizationAudit({
      organizationId,
      dealershipId,
      actorUserId: user.id,
      action: 'access_request.created',
      targetType: 'access_request',
      targetId: id,
      data: { requestedRole }
    }, tx);
    return rows[0];
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function listUserAccessRequests(userId, db = pool) {
  const { rows } = await db.query(
    `select r.id, r.organization_id, o.name as organization_name,
            r.dealership_id, d.name as dealership_name, r.requested_role,
            r.status, r.created_at, r.reviewed_at, r.updated_at
       from organization_access_requests r
       join "organization" o on o.id=r.organization_id
       join dealerships d on d.id=r.dealership_id
      where r.user_id=$1
      order by r.created_at desc limit 50`,
    [userId]
  );
  return rows;
}

async function ensureMemberForUser({ organizationId, userId, role }, db) {
  const { rows: existing } = await db.query(
    `select id from "member" where "organizationId"=$1 and "userId"=$2 for update`,
    [organizationId, userId]
  );
  const memberId = existing[0] ? existing[0].id : crypto.randomUUID();
  if (!existing.length) {
    await db.query(
      `insert into "member" (id, "organizationId", "userId", role, "createdAt")
       values ($1,$2,$3,'member',now())`,
      [memberId, organizationId, userId]
    );
  }
  await db.query(
    `insert into organization_member_profiles (
       member_id, organization_id, user_id, role, all_rooftops, status, removed_at
     ) values ($1,$2,$3,$4,false,'active',null)
     on conflict (member_id) do update set
       role=excluded.role, status='active', removed_at=null, updated_at=now()`,
    [memberId, organizationId, userId, role]
  );
  return memberId;
}

async function grantRooftopAccess({ memberId, organizationId, dealershipId, role }, db) {
  await db.query(
    `insert into member_rooftop_access (member_id, organization_id, dealership_id, role, revoked_at)
     values ($1,$2,$3,$4,null)
     on conflict (member_id, dealership_id) do update set
       role=excluded.role, revoked_at=null, created_at=now()`,
    [memberId, organizationId, dealershipId, role]
  );
}

export async function listAccessRequests(actorUserId, organizationId, db = pool) {
  const actor = await requireMembership(actorUserId, organizationId, db);
  if (!['owner', 'manager'].includes(actor.role)) {
    throw domainError('team management access required', 403, 'manager_required');
  }
  const { rows } = await db.query(
    `select r.*, u.name as user_name
       from organization_access_requests r
       join "user" u on u.id=r.user_id
      where r.organization_id=$1
        and ($2='owner' or (
          r.requested_role='salesperson' and r.dealership_id in (
            select dealership_id from member_rooftop_access
             where member_id=$3 and revoked_at is null
          )
        ))
      order by r.created_at desc`,
    [organizationId, actor.role, actor.member_id]
  );
  return rows;
}

export async function decideAccessRequest(actorUserId, organizationId, requestId, {
  approve,
  reason = null
} = {}, db = pool) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select * from organization_access_requests
        where id=$1 and organization_id=$2 for update`,
      [requestId, organizationId]
    );
    const request = rows[0];
    if (!request) throw domainError('access request not found', 404, 'not_found');
    if (!['pending', 'approved_awaiting_capacity'].includes(request.status)) {
      return { request, changed: false };
    }
    const actor = await requireMembership(actorUserId, organizationId, tx);
    await requireTeamManagement(actor, request.dealership_id, request.requested_role, tx);
    if (!approve) {
      const { rows: rejected } = await tx.query(
        `update organization_access_requests set status='rejected', reviewed_by=$3,
           reviewed_at=now(), updated_at=now() where id=$1 and organization_id=$2 returning *`,
        [requestId, organizationId, actorUserId]
      );
      await recordOrganizationAudit({
        organizationId,
        dealershipId: request.dealership_id,
        actorUserId,
        action: 'access_request.rejected',
        targetType: 'access_request',
        targetId: requestId,
        reason
      }, tx);
      await createOrganizationNotification({
        userId: request.user_id,
        organizationId,
        type: 'access_request_rejected',
        data: { dealershipId: request.dealership_id, reason: reason || null }
      }, tx);
      return { request: rejected[0], changed: true };
    }

    const memberId = await ensureMemberForUser({
      organizationId,
      userId: request.user_id,
      role: request.requested_role
    }, tx);
    await grantRooftopAccess({
      memberId,
      organizationId,
      dealershipId: request.dealership_id,
      role: request.requested_role
    }, tx);

    let status = 'approved';
    if (request.requested_role === 'salesperson') {
      try {
        await assignSeatLocked({
          organizationId,
          dealershipId: request.dealership_id,
          memberId,
          actorUserId
        }, tx);
      } catch (err) {
        if (err.reason !== 'no_capacity') throw err;
        status = 'approved_awaiting_capacity';
      }
    }
    const { rows: updated } = await tx.query(
      `update organization_access_requests set status=$3, reviewed_by=$4,
         reviewed_at=now(), updated_at=now() where id=$1 and organization_id=$2 returning *`,
      [requestId, organizationId, status, actorUserId]
    );
    await recordOrganizationAudit({
      organizationId,
      dealershipId: request.dealership_id,
      actorUserId,
      action: status === 'approved' ? 'access_request.approved' : 'access_request.awaiting_capacity',
      targetType: 'access_request',
      targetId: requestId,
      reason,
      data: { memberId, requestedRole: request.requested_role }
    }, tx);
    await createOrganizationNotification({
      userId: request.user_id,
      organizationId,
      type: status === 'approved' ? 'access_request_approved' : 'access_request_waiting',
      data: { dealershipId: request.dealership_id, memberId }
    }, tx);
    return { request: updated[0], memberId, changed: true };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function activateWaitingRequests(organizationId, dealershipId, db = pool) {
  let activated = 0;
  for (;;) {
    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `select r.*, m.id as member_id
           from organization_access_requests r
           join "member" m on m."organizationId"=r.organization_id and m."userId"=r.user_id
          where r.organization_id=$1 and r.dealership_id=$2
            and r.status='approved_awaiting_capacity'
          order by r.reviewed_at nulls last,r.created_at,r.id
          limit 1 for update of r`,
        [organizationId, dealershipId]
      );
      if (!rows.length) return { done: true };
      const request = rows[0];
      try {
        await assignSeatLocked({
          organizationId,
          dealershipId,
          memberId: request.member_id,
          actorUserId: null
        }, tx);
      } catch (err) {
        if (err.reason === 'no_capacity') return { done: true };
        throw err;
      }
      await tx.query(
        `update organization_access_requests set status='approved',updated_at=now()
          where id=$1`,
        [request.id]
      );
      await recordOrganizationAudit({
        organizationId,
        dealershipId,
        actorUserId: 'system:capacity',
        action: 'access_request.capacity_activated',
        targetType: 'access_request',
        targetId: request.id,
        data: { memberId: request.member_id }
      }, tx);
      await createOrganizationNotification({
        userId: request.user_id,
        organizationId,
        type: 'access_request_approved',
        data: { dealershipId, memberId: request.member_id }
      }, tx);
      return { done: false };
    }, { db, isolation: 'serializable', retries: 2 });
    if (result.done) break;
    activated += 1;
  }
  return activated;
}

async function cancelPendingInvitations(organizationId, email, db) {
  const { rows } = await db.query(
    `update "invitation" set status='canceled'
      where "organizationId"=$1 and lower(email)=$2 and status='pending'
      returning id`,
    [organizationId, email]
  );
  if (rows.length) {
    await db.query(
      `update seat_reservations set released_at=now()
        where target_type='invitation' and target_id=any($1) and released_at is null`,
      [rows.map((row) => row.id)]
    );
  }
}

export async function createInvitation(actorUserId, organizationId, {
  email,
  role = 'salesperson',
  dealershipIds = [],
  allRooftops = false,
  reserveSeat = true
} = {}, db = pool) {
  const normalizedEmail = normalizeEmail(email);
  const rooftops = [...new Set((Array.isArray(dealershipIds) ? dealershipIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))];
  if (!normalizedEmail || !normalizedEmail.includes('@')) throw domainError('valid email is required');
  if (!['manager', 'salesperson'].includes(role)) throw domainError('invalid role', 400, 'invalid_role');
  if (!allRooftops && !rooftops.length) throw domainError('choose at least one rooftop', 400, 'invalid_rooftops');
  if (allRooftops && role !== 'manager') throw domainError('all-rooftop scope is manager-only', 400, 'invalid_scope');

  const invitation = await withTransaction(async (tx) => {
    const actor = await requireMembership(actorUserId, organizationId, tx);
    if (allRooftops) requireOwner(actor);
    for (const dealershipId of rooftops) {
      await requireTeamManagement(actor, dealershipId, role, tx);
    }
    const { rows: existingUser } = await tx.query('select id from "user" where lower(email)=$1', [normalizedEmail]);
    if (existingUser.length) {
      const { rows: existingMember } = await tx.query(
        `select m.id,coalesce(mp.status,'active') as status
           from "member" m
           left join organization_member_profiles mp on mp.member_id=m.id
          where m."organizationId"=$1 and m."userId"=$2`,
        [organizationId, existingUser[0].id]
      );
      if (existingMember.length && existingMember[0].status !== 'removed') {
        throw domainError('user already belongs to this organization', 409, 'already_member');
      }
    }

    await cancelPendingInvitations(organizationId, normalizedEmail, tx);
    const invitationId = crypto.randomUUID();
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
    await tx.query(
      `insert into "invitation" (
         id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId"
       ) values ($1,$2,$3,'member','pending',$4,now(),$5)`,
      [invitationId, organizationId, normalizedEmail, expiresAt, actorUserId]
    );
    await tx.query(
      `insert into organization_invitation_scopes (
         invitation_id, token_hash, organization_id, requested_role, all_rooftops
       ) values ($1,$2,$3,$4,$5)`,
      [invitationId, hashToken(rawToken), organizationId, role, Boolean(allRooftops)]
    );

    const effectiveRooftops = allRooftops
      ? (await tx.query(
          `select dealership_id from organization_rooftops
            where organization_id=$1 and status in ('active','past_due','suspended','pending_removal')`,
          [organizationId]
        )).rows.map((row) => row.dealership_id)
      : rooftops;
    for (const dealershipId of effectiveRooftops) {
      await lockRooftop(organizationId, dealershipId, tx);
      await tx.query(
        `insert into organization_invitation_rooftops (
           invitation_id, dealership_id, role, reserve_seat
         ) values ($1,$2,$3,$4)`,
        [invitationId, dealershipId, role, Boolean(reserveSeat && role === 'salesperson')]
      );
      if (reserveSeat && role === 'salesperson') {
        const capacity = await capacitySnapshotLocked(organizationId, dealershipId, tx);
        if (capacity.available < 1) throw domainError('no listing seats available', 409, 'no_capacity');
        await tx.query(
          `insert into seat_reservations (
             id, organization_id, dealership_id, target_type, target_id, expires_at
           ) values ($1,$2,$3,'invitation',$4,$5)`,
          [crypto.randomUUID(), organizationId, dealershipId, invitationId, expiresAt]
        );
      }
    }
    await recordOrganizationAudit({
      organizationId,
      actorUserId,
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: invitationId,
      data: { email: normalizedEmail, role, dealershipIds: effectiveRooftops, allRooftops }
    }, tx);
    const organizationResult = await tx.query('select name from "organization" where id=$1', [organizationId]);
    const inviterResult = await tx.query('select name from "user" where id=$1', [actorUserId]);
    const dealershipResult = await tx.query(
      'select name from dealerships where id=any($1) order by name',
      [effectiveRooftops]
    );
    return {
      id: invitationId,
      token: rawToken,
      email: normalizedEmail,
      role,
      expiresAt,
      organizationName: organizationResult.rows[0] && organizationResult.rows[0].name,
      inviterName: inviterResult.rows[0] && inviterResult.rows[0].name,
      rooftopNames: dealershipResult.rows.map((row) => row.name)
    };
  }, { db, isolation: 'serializable', retries: 2 });

  const delivery = await notifyOrganizationInvitation({
    ...invitation,
    code: invitation.token,
    storeUrl: process.env.EXTENSION_STORE_URL || ''
  });
  return { ...invitation, delivery };
}

export async function acceptInvitation(user, token, db = pool) {
  const tokenHash = hashToken(token);
  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select i.*, s.requested_role, s.all_rooftops, s.organization_id
         from organization_invitation_scopes s
         join "invitation" i on i.id=s.invitation_id
        where s.token_hash=$1 for update of i`,
      [tokenHash]
    );
    const invitation = rows[0];
    if (!invitation) return { error: domainError('invitation not found', 404, 'invalid_invitation') };
    if (invitation.status !== 'pending') {
      return { error: domainError('invitation is no longer active', 409, 'invitation_used') };
    }
    if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
      await tx.query('update "invitation" set status=\'expired\' where id=$1', [invitation.id]);
      await tx.query(
        `update seat_reservations set released_at=now()
          where target_type='invitation' and target_id=$1 and released_at is null`,
        [invitation.id]
      );
      return { error: domainError('invitation has expired', 410, 'invitation_expired') };
    }
    if (!user.emailVerified) return { error: domainError('verify your email before accepting', 409, 'email_not_verified') };
    if (normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
      return { error: domainError('sign in with the invited email', 403, 'email_mismatch') };
    }
    const { rows: already } = await tx.query(
      `select m.id,coalesce(mp.status,'active') as status
         from "member" m
         left join organization_member_profiles mp on mp.member_id=m.id
        where m."organizationId"=$1 and m."userId"=$2`,
      [invitation.organization_id, user.id]
    );
    if (already.length && already[0].status !== 'removed') {
      await tx.query('update "invitation" set status=\'accepted\' where id=$1', [invitation.id]);
      await tx.query(
        `update seat_reservations set released_at=now()
          where target_type='invitation' and target_id=$1 and released_at is null`,
        [invitation.id]
      );
      return { error: domainError('user already belongs to this organization', 409, 'already_member') };
    }

    const memberId = await ensureMemberForUser({
      organizationId: invitation.organization_id,
      userId: user.id,
      role: invitation.requested_role
    }, tx);
    const { rows: rooftopRows } = await tx.query(
      `select * from organization_invitation_rooftops where invitation_id=$1`,
      [invitation.id]
    );
    for (const rooftop of rooftopRows) {
      await grantRooftopAccess({
        memberId,
        organizationId: invitation.organization_id,
        dealershipId: rooftop.dealership_id,
        role: rooftop.role
      }, tx);
      if (rooftop.reserve_seat) {
        const { rows: reservationRows } = await tx.query(
          `select id from seat_reservations
            where target_type='invitation' and target_id=$1 and dealership_id=$2
              and released_at is null and expires_at > now()
            for update`,
          [invitation.id, rooftop.dealership_id]
        );
        if (!reservationRows.length) {
          throw domainError('reserved seat is no longer available', 409, 'no_capacity');
        }
        await tx.query(
          `update seat_reservations set released_at=now() where id=$1`,
          [reservationRows[0].id]
        );
        // The reservation was removed before capacity is checked, leaving exactly one slot.
        await assignSeatLocked({
          organizationId: invitation.organization_id,
          dealershipId: rooftop.dealership_id,
          memberId,
          actorUserId: invitation.inviterId
        }, tx);
      }
    }
    if (invitation.all_rooftops && invitation.requested_role === 'manager') {
      await tx.query(
        `update organization_member_profiles set all_rooftops=true, updated_at=now()
          where member_id=$1`,
        [memberId]
      );
    }
    await tx.query('update "invitation" set status=\'accepted\' where id=$1', [invitation.id]);
    await recordOrganizationAudit({
      organizationId: invitation.organization_id,
      actorUserId: user.id,
      action: 'invitation.accepted',
      targetType: 'member',
      targetId: memberId,
      data: { invitationId: invitation.id }
    }, tx);
    await createOrganizationNotification({
      userId: invitation.inviterId,
      organizationId: invitation.organization_id,
      type: 'invitation_accepted',
      data: { invitationId: invitation.id, memberId, userId: user.id }
    }, tx);
    return { organizationId: invitation.organization_id, memberId };
  }, { db, isolation: 'serializable', retries: 2 });
  if (result.error) throw result.error;
  return result;
}

export async function listMembers(actorUserId, organizationId, db = pool) {
  const actor = await requireMembership(actorUserId, organizationId, db);
  const { rows } = await db.query(
    `with member_base as (
       select m.id as member_id,m."userId" as user_id,u.name as user_name,u.email as user_email,
              coalesce(mp.role,case when m.role='owner' then 'owner' else 'salesperson' end) as role,
              coalesce(mp.all_rooftops,false) as all_rooftops,
              coalesce(mp.status,'active') as status,m."createdAt" as created_at
         from "member" m
         join "user" u on u.id=m."userId"
         left join organization_member_profiles mp on mp.member_id=m.id
        where m."organizationId"=$1 and coalesce(mp.status,'active') <> 'removed'
     )
     select b.* from member_base b
      where $2='owner'
         or b.member_id=$3
         or ($2='manager' and b.role='salesperson' and exists (
           select 1 from member_rooftop_access target_access
            where target_access.member_id=b.member_id and target_access.revoked_at is null
              and target_access.dealership_id in (
                select actor_access.dealership_id from member_rooftop_access actor_access
                 where actor_access.member_id=$3 and actor_access.revoked_at is null
              )
         ))
      order by case b.role when 'owner' then 1 when 'manager' then 2 else 3 end,
               b.user_name,b.user_email`,
    [organizationId, actor.role, actor.member_id]
  );
  if (!rows.length) return [];

  const memberIds = rows.map((row) => row.member_id);
  const { rows: rooftopRows } = await db.query(
    `select m.id as member_id,r.dealership_id,d.name as dealership_name,
            coalesce(a.role,mp.role) as role,
            exists (
              select 1 from seat_assignments s
               where s.organization_id=$1 and s.dealership_id=r.dealership_id
                 and s.member_id=m.id and s.released_at is null
            ) as has_seat
       from "member" m
       join organization_member_profiles mp on mp.member_id=m.id
       join organization_rooftops r on r.organization_id=m."organizationId"
         and r.status in ('active','past_due','suspended','pending_removal')
       join dealerships d on d.id=r.dealership_id
       left join member_rooftop_access a on a.member_id=m.id
         and a.organization_id=$1 and a.dealership_id=r.dealership_id and a.revoked_at is null
      where m."organizationId"=$1 and m.id=any($2)
        and (mp.role='owner' or mp.all_rooftops=true or a.member_id is not null)
      order by d.name,d.id`,
    [organizationId, memberIds]
  );
  const rooftopsByMember = new Map();
  for (const rooftop of rooftopRows) {
    if (!rooftopsByMember.has(rooftop.member_id)) rooftopsByMember.set(rooftop.member_id, []);
    rooftopsByMember.get(rooftop.member_id).push({
      dealershipId: rooftop.dealership_id,
      dealershipName: rooftop.dealership_name,
      role: rooftop.role,
      hasSeat: Boolean(rooftop.has_seat)
    });
  }
  return rows.map((row) => publicMember({
    ...row,
    rooftops: rooftopsByMember.get(row.member_id) || []
  }));
}

export async function removeMember(actorUserId, organizationId, memberId, {
  dealershipId = null,
  reason = null
} = {}, db = pool) {
  const result = await withTransaction(async (tx) => {
    const actor = await requireMembership(actorUserId, organizationId, tx);
    const target = await getTargetMember(organizationId, memberId, tx, { lock: true });
    if (!target) throw domainError('member not found', 404, 'member_not_found');
    if (target.role === 'owner') throw domainError('transfer ownership before removing the owner', 409, 'owner_transfer_required');
    let releasedRooftops = [];

    if (actor.role !== 'owner') {
      if (!dealershipId) throw domainError('manager removal must name a rooftop', 400, 'rooftop_required');
      await requireTeamManagement(actor, dealershipId, target.role, tx);
      if (target.role !== 'salesperson') throw domainError('only owners can remove managers', 403, 'owner_required');
      await tx.query(
        `update member_rooftop_access set revoked_at=now()
          where member_id=$1 and organization_id=$2 and dealership_id=$3 and revoked_at is null`,
        [memberId, organizationId, dealershipId]
      );
      const released = await tx.query(
        `update seat_assignments set released_at=now(), released_by=$4
          where member_id=$1 and organization_id=$2 and dealership_id=$3 and released_at is null
          returning dealership_id`,
        [memberId, organizationId, dealershipId, actorUserId]
      );
      releasedRooftops = released.rows.map((row) => row.dealership_id);
      const { rows: remaining } = await tx.query(
        `select 1 from member_rooftop_access where member_id=$1 and revoked_at is null limit 1`,
        [memberId]
      );
      if (!remaining.length) {
        await tx.query(
          `update organization_member_profiles set status='removed', removed_at=now(), updated_at=now()
            where member_id=$1`,
          [memberId]
        );
      }
    } else {
      const released = await tx.query(
        `update seat_assignments set released_at=now(), released_by=$3
          where member_id=$1 and organization_id=$2 and released_at is null
          returning dealership_id`,
        [memberId, organizationId, actorUserId]
      );
      releasedRooftops = released.rows.map((row) => row.dealership_id);
      await tx.query(
        `update member_rooftop_access set revoked_at=now()
          where member_id=$1 and organization_id=$2 and revoked_at is null`,
        [memberId, organizationId]
      );
      await tx.query(
        `update organization_member_profiles set status='removed', removed_at=now(), updated_at=now()
          where member_id=$1`,
        [memberId]
      );
    }
    await recordOrganizationAudit({
      organizationId,
      dealershipId,
      actorUserId,
      action: dealershipId ? 'member.rooftop_removed' : 'member.removed',
      targetType: 'member',
      targetId: memberId,
      reason
    }, tx);
    await createOrganizationNotification({
      userId: target.user_id,
      organizationId,
      type: 'member_removed',
      data: { dealershipId, reason: reason || null }
    }, tx);
    return { removed: true, releasedRooftops: [...new Set(releasedRooftops)] };
  }, { db, isolation: 'serializable', retries: 2 });
  for (const releasedDealershipId of result.releasedRooftops) {
    await activateWaitingRequests(organizationId, releasedDealershipId, db);
  }
  return { removed: result.removed };
}

export async function listNotifications(userId, db = pool) {
  const { rows } = await db.query(
    `select id, organization_id, type, data, created_at, read_at
       from organization_notifications where user_id=$1
      order by created_at desc limit 100`,
    [userId]
  );
  return rows;
}

export async function expireOrganizationInvitations(db = pool) {
  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `update "invitation" set status='expired'
        where status='pending' and "expiresAt" <= now()
        returning id, "organizationId" as organization_id, email`,
    );
    let releasedRooftops = [];
    if (rows.length) {
      const reservationResult = await tx.query(
        `select distinct organization_id,dealership_id from seat_reservations
          where target_type='invitation' and target_id=any($1) and released_at is null`,
        [rows.map((row) => row.id)]
      );
      releasedRooftops = reservationResult.rows;
      await tx.query(
        `update seat_reservations set released_at=now()
          where target_type='invitation' and target_id=any($1) and released_at is null`,
        [rows.map((row) => row.id)]
      );
      for (const invitation of rows) {
        await recordOrganizationAudit({
          organizationId: invitation.organization_id,
          actorUserId: 'system:invitations',
          action: 'invitation.expired',
          targetType: 'invitation',
          targetId: invitation.id
        }, tx);
      }
    }
    return { count: rows.length, releasedRooftops };
  }, { db });
  for (const rooftop of result.releasedRooftops) {
    await activateWaitingRequests(rooftop.organization_id, rooftop.dealership_id, db);
  }
  return result.count;
}

export async function markNotificationRead(userId, notificationId, db = pool) {
  const { rowCount } = await db.query(
    `update organization_notifications set read_at=coalesce(read_at,now())
      where id=$1 and user_id=$2`,
    [notificationId, userId]
  );
  if (!rowCount) throw domainError('notification not found', 404, 'not_found');
  return { read: true };
}

export { normalizeEmail, hashToken };
