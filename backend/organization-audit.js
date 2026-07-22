import crypto from 'node:crypto';
import { pool } from './db.js';

export async function recordOrganizationAudit({
  organizationId = null,
  dealershipId = null,
  actorUserId = null,
  action,
  targetType = null,
  targetId = null,
  reason = null,
  data = null
}, db = pool) {
  if (!action) throw new Error('audit action is required');
  const id = crypto.randomUUID();
  await db.query(
    `insert into organization_audit_events (
       id, organization_id, dealership_id, actor_user_id, action,
       target_type, target_id, reason, data
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id, organizationId, dealershipId, actorUserId, action,
      targetType, targetId, reason,
      data == null ? null : JSON.stringify(data)
    ]
  );
  return id;
}

export async function createOrganizationNotification({
  userId,
  organizationId = null,
  type,
  data = null
}, db = pool) {
  if (!userId || !type) throw new Error('notification user and type are required');
  const id = crypto.randomUUID();
  await db.query(
    `insert into organization_notifications (id, user_id, organization_id, type, data)
     values ($1,$2,$3,$4,$5)`,
    [id, userId, organizationId, type, data == null ? null : JSON.stringify(data)]
  );
  return id;
}
