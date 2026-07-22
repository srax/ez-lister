import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { createOrganizationNotification, recordOrganizationAudit } from './organization-audit.js';

function recoveryError(message, status = 400, reason = 'invalid_recovery') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function cleanReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

// Support-only break-glass path for a lost or compromised owner account. The target must have
// completed Google sign-in already so recovery never creates an unverified identity. The former
// owner is suspended rather than deleted, preserving historical attribution and reversibility.
export async function recoverOrganizationOwner(organizationId, {
  targetUserId = null,
  targetEmail = null,
  actor = 'admin',
  reason
} = {}, db = pool) {
  const rationale = cleanReason(reason);
  if (!rationale) throw recoveryError('recovery reason is required', 400, 'reason_required');
  const normalizedEmail = String(targetEmail || '').trim().toLowerCase();
  if (!targetUserId && !normalizedEmail) {
    throw recoveryError('targetUserId or targetEmail is required', 400, 'target_required');
  }

  return withTransaction(async (tx) => {
    const { rows: organizations } = await tx.query(
      `select o.id,o.name,p.primary_owner_member_id
         from "organization" o
         join organization_profiles p on p.organization_id=o.id
        where o.id=$1 for update of o,p`,
      [organizationId]
    );
    const organization = organizations[0];
    if (!organization) throw recoveryError('organization not found', 404, 'not_found');

    const { rows: users } = await tx.query(
      `select id,email,name,"emailVerified" as email_verified from "user"
        where ($1::text is not null and id=$1)
           or ($1::text is null and lower(email)=$2)
        limit 1 for update`,
      [targetUserId || null, normalizedEmail || null]
    );
    const targetUser = users[0];
    if (!targetUser || !targetUser.email_verified) {
      throw recoveryError(
        'target must sign in with a verified Google account before recovery',
        409,
        'verified_target_required'
      );
    }

    const { rows: targetRows } = await tx.query(
      `select m.id from "member" m
        where m."organizationId"=$1 and m."userId"=$2 for update`,
      [organizationId, targetUser.id]
    );
    let targetMemberId = targetRows[0] && targetRows[0].id;
    if (!targetMemberId) {
      targetMemberId = crypto.randomUUID();
      await tx.query(
        `insert into "member" (id,"organizationId","userId",role,"createdAt")
         values ($1,$2,$3,'member',now())`,
        [targetMemberId, organizationId, targetUser.id]
      );
      await tx.query(
        `insert into organization_member_profiles (
           member_id,organization_id,user_id,role,all_rooftops,status
         ) values ($1,$2,$3,'salesperson',false,'active')`,
        [targetMemberId, organizationId, targetUser.id]
      );
    }
    await tx.query(
      `insert into organization_member_profiles (
         member_id,organization_id,user_id,role,all_rooftops,status
       ) values ($1,$2,$3,'salesperson',false,'active')
       on conflict (member_id) do nothing`,
      [targetMemberId, organizationId, targetUser.id]
    );

    const formerOwnerMemberId = organization.primary_owner_member_id;
    if (formerOwnerMemberId === targetMemberId) {
      return {
        recovered: false,
        organizationId,
        ownerMemberId: targetMemberId,
        ownerUserId: targetUser.id
      };
    }
    if (!formerOwnerMemberId) {
      throw recoveryError('organization has no recorded primary owner', 409, 'owner_missing');
    }

    const { rows: formerRows } = await tx.query(
      `select "userId" as user_id from "member"
        where id=$1 and "organizationId"=$2 for update`,
      [formerOwnerMemberId, organizationId]
    );
    if (!formerRows.length) throw recoveryError('recorded owner member is missing', 409, 'owner_missing');

    await tx.query(
      `update "member" set role='member'
        where "organizationId"=$1 and role='owner'`,
      [organizationId]
    );
    await tx.query(`update "member" set role='owner' where id=$1`, [targetMemberId]);
    await tx.query(
      `update organization_member_profiles
          set role='manager',all_rooftops=true,status='suspended',updated_at=now()
        where member_id=$1`,
      [formerOwnerMemberId]
    );
    await tx.query(
      `update organization_member_profiles
          set role='owner',all_rooftops=false,status='active',removed_at=null,
              listing_preference=null,listing_preference_at=null,updated_at=now()
        where member_id=$1`,
      [targetMemberId]
    );
    const { rows: releasedSeats } = await tx.query(
      `update seat_assignments set released_at=now(),released_by=null
        where organization_id=$1 and member_id=$2 and released_at is null
        returning dealership_id`,
      [organizationId, formerOwnerMemberId]
    );
    await tx.query(
      `update organization_profiles set primary_owner_member_id=$2,updated_at=now()
        where organization_id=$1`,
      [organizationId, targetMemberId]
    );
    await tx.query(
      `update organization_ownership_transfers set status='canceled',canceled_at=now()
        where organization_id=$1 and status='pending'`,
      [organizationId]
    );
    await recordOrganizationAudit({
      organizationId,
      actorUserId: actor,
      action: 'ownership_recovery.completed',
      targetType: 'member',
      targetId: targetMemberId,
      reason: rationale,
      data: {
        formerOwnerMemberId,
        targetUserId: targetUser.id,
        releasedSeatDealershipIds: releasedSeats.map((row) => row.dealership_id)
      }
    }, tx);
    await createOrganizationNotification({
      userId: targetUser.id,
      organizationId,
      type: 'ownership_recovery_completed',
      data: { organizationName: organization.name }
    }, tx);
    await createOrganizationNotification({
      userId: formerRows[0].user_id,
      organizationId,
      type: 'ownership_recovery_former_owner_suspended',
      data: { organizationName: organization.name }
    }, tx);
    return {
      recovered: true,
      organizationId,
      ownerMemberId: targetMemberId,
      ownerUserId: targetUser.id,
      formerOwnerMemberId,
      releasedSeats: releasedSeats.length
    };
  }, { db, isolation: 'serializable', retries: 2 });
}
