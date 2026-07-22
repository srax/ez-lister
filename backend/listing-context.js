import { pool } from './db.js';
import { getWorkspaceContext, personalWorkspaceId } from './workspaces.js';

function contextError(message, status, reason) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

export async function resolveListingContext(userId, {
  workspaceId = null,
  dealershipId = null
} = {}, db = pool) {
  if (!workspaceId) {
    const { rows } = await db.query(
      'select dealership_id from user_dealerships where user_id=$1',
      [userId]
    );
    return {
      workspaceId: personalWorkspaceId(userId),
      workspaceType: 'personal',
      organizationId: null,
      dealershipId: rows[0] ? rows[0].dealership_id : null,
      actorUserId: userId,
      role: 'personal',
      hasSeat: true
    };
  }

  const context = await getWorkspaceContext(userId, {
    requestedId: workspaceId,
    dealershipId: dealershipId || null
  }, db);
  if (!context.selected) throw contextError('workspace not found', 404, 'workspace_not_found');
  if (!context.rooftop) throw contextError('choose an accessible rooftop', 409, 'rooftop_required');
  if (context.selected.type === 'organization' && !context.rooftop.hasSeat) {
    // Queue sync is auth-only, but a member who never held a listing seat must not create
    // organization listing history. Later removal can still sync an already-known listing.
    const { rows } = await db.query(
      `select 1 from listings
        where workspace_id=$1 and actor_user_id=$2 and dealership_id=$3 limit 1`,
      [context.selected.id, userId, context.rooftop.dealership.id]
    );
    if (!rows.length) throw contextError('an active rooftop listing seat is required', 403, 'no_seat');
  }
  return {
    workspaceId: context.selected.id,
    workspaceType: context.selected.type,
    organizationId: context.selected.type === 'organization'
      ? context.selected.organization.id
      : null,
    dealershipId: context.rooftop.dealership.id,
    actorUserId: userId,
    role: context.selected.type === 'organization'
      ? context.selected.member.role
      : 'personal',
    hasSeat: Boolean(context.rooftop.hasSeat)
  };
}
