import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { requireMembership, requireOwner } from './organization-authz.js';
import { createOrganizationNotification, recordOrganizationAudit } from './organization-audit.js';
import { hashToken } from './organizations.js';
import { notifyOwnershipTransfer } from './email.js';

const REAUTH_WINDOW_MS = 15 * 60 * 1000;
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

function transferError(message, status = 400, reason = 'invalid_transfer') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

export function hasRecentAuthentication(sessionCreatedAt, now = Date.now()) {
  const createdAt = new Date(sessionCreatedAt).getTime();
  return Number.isFinite(createdAt) && createdAt <= now && now - createdAt <= REAUTH_WINDOW_MS;
}

export async function initiateOwnershipTransfer(
  actorUserId,
  organizationId,
  targetMemberId,
  { sessionCreatedAt } = {},
  db = pool
) {
  if (!hasRecentAuthentication(sessionCreatedAt)) {
    throw transferError(
      'sign out and sign in with Google again before transferring ownership',
      401,
      'recent_reauthentication_required'
    );
  }
  const transfer = await withTransaction(async (tx) => {
    const actor = await requireMembership(actorUserId, organizationId, tx);
    requireOwner(actor);
    await tx.query('select id from "organization" where id=$1 for update', [organizationId]);
    const { rows: targetRows } = await tx.query(
      `select m.id as member_id,m."userId" as user_id,u.email,u.name,
              coalesce(mp.role,'salesperson') as role,coalesce(mp.status,'active') as status
         from "member" m
         join "user" u on u.id=m."userId"
         left join organization_member_profiles mp on mp.member_id=m.id
        where m.id=$1 and m."organizationId"=$2 for update of m`,
      [targetMemberId, organizationId]
    );
    const target = targetRows[0];
    if (!target || target.status !== 'active') {
      throw transferError('active target member not found', 404, 'member_not_found');
    }
    if (target.member_id === actor.member_id) {
      throw transferError('choose another member as the new owner', 409, 'already_owner');
    }
    await tx.query(
      `update organization_ownership_transfers set status='canceled',canceled_at=now()
        where organization_id=$1 and status='pending'`,
      [organizationId]
    );
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString();
    await tx.query(
      `insert into organization_ownership_transfers (
         id,organization_id,from_member_id,to_member_id,token_hash,expires_at
       ) values ($1,$2,$3,$4,$5,$6)`,
      [id, organizationId, actor.member_id, target.member_id, hashToken(token), expiresAt]
    );
    const organizationResult = await tx.query('select name from "organization" where id=$1', [organizationId]);
    const actorResult = await tx.query('select name from "user" where id=$1', [actorUserId]);
    await recordOrganizationAudit({
      organizationId,
      actorUserId,
      action: 'ownership_transfer.initiated',
      targetType: 'member',
      targetId: target.member_id,
      data: { transferId: id, expiresAt }
    }, tx);
    return {
      id,
      token,
      expiresAt,
      targetEmail: target.email,
      targetName: target.name,
      organizationName: organizationResult.rows[0] && organizationResult.rows[0].name,
      currentOwnerName: actorResult.rows[0] && actorResult.rows[0].name
    };
  }, { db, isolation: 'serializable', retries: 2 });

  const delivery = await notifyOwnershipTransfer({
    ...transfer,
    email: transfer.targetEmail,
    code: transfer.token,
    storeUrl: process.env.EXTENSION_STORE_URL || ''
  });
  return { ...transfer, delivery };
}

export async function acceptOwnershipTransfer(userId, token, db = pool) {
  const tokenHash = hashToken(token);
  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select t.*,target."userId" as target_user_id
         from organization_ownership_transfers t
         join "member" target on target.id=t.to_member_id
        where t.token_hash=$1 for update of t`,
      [tokenHash]
    );
    const transfer = rows[0];
    if (!transfer) throw transferError('ownership transfer not found', 404, 'invalid_transfer');
    if (transfer.status !== 'pending') {
      throw transferError('ownership transfer is no longer active', 409, 'transfer_used');
    }
    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
      await tx.query(
        `update organization_ownership_transfers set status='expired' where id=$1`,
        [transfer.id]
      );
      return { error: transferError('ownership transfer has expired', 410, 'transfer_expired') };
    }
    if (transfer.target_user_id !== userId) {
      throw transferError('sign in as the selected new owner', 403, 'transfer_target_mismatch');
    }
    await tx.query('select id from "organization" where id=$1 for update', [transfer.organization_id]);
    const { rows: profileRows } = await tx.query(
      `select primary_owner_member_id from organization_profiles
        where organization_id=$1 for update`,
      [transfer.organization_id]
    );
    if (!profileRows.length || profileRows[0].primary_owner_member_id !== transfer.from_member_id) {
      throw transferError('organization ownership changed before acceptance', 409, 'owner_changed');
    }
    await tx.query(
      `update "member" set role='member'
        where "organizationId"=$1 and role='owner' and id<>$2`,
      [transfer.organization_id, transfer.to_member_id]
    );
    await tx.query('update "member" set role=\'owner\' where id=$1', [transfer.to_member_id]);
    await tx.query(
      `update organization_member_profiles set role='manager',all_rooftops=true,updated_at=now()
        where organization_id=$1 and role='owner' and member_id<>$2`,
      [transfer.organization_id, transfer.to_member_id]
    );
    await tx.query(
      `update organization_member_profiles set role='owner',status='active',removed_at=null,
         all_rooftops=false,listing_preference=null,listing_preference_at=null,updated_at=now()
        where member_id=$1`,
      [transfer.to_member_id]
    );
    await tx.query(
      `update organization_profiles set primary_owner_member_id=$2,updated_at=now()
        where organization_id=$1`,
      [transfer.organization_id, transfer.to_member_id]
    );
    await tx.query(
      `update organization_ownership_transfers set status='accepted',accepted_at=now()
        where id=$1`,
      [transfer.id]
    );
    await recordOrganizationAudit({
      organizationId: transfer.organization_id,
      actorUserId: userId,
      action: 'ownership_transfer.accepted',
      targetType: 'member',
      targetId: transfer.to_member_id,
      data: { transferId: transfer.id, formerOwnerMemberId: transfer.from_member_id }
    }, tx);
    const formerOwnerResult = await tx.query(
      'select "userId" as user_id from "member" where id=$1',
      [transfer.from_member_id]
    );
    if (formerOwnerResult.rows[0]) {
      await createOrganizationNotification({
        userId: formerOwnerResult.rows[0].user_id,
        organizationId: transfer.organization_id,
        type: 'ownership_transfer_accepted',
        data: { newOwnerUserId: userId }
      }, tx);
    }
    return { organizationId: transfer.organization_id, ownerMemberId: transfer.to_member_id };
  }, { db, isolation: 'serializable', retries: 2 });
  if (result.error) throw result.error;
  return result;
}

export async function expireOwnershipTransfers(db = pool) {
  const { rowCount } = await db.query(
    `update organization_ownership_transfers set status='expired'
      where status='pending' and expires_at <= now()`
  );
  return rowCount;
}
