import { pool } from './db.js';

export class OrganizationAccessError extends Error {
  constructor(message, status = 403, reason = 'forbidden') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export async function getMembership(userId, organizationId, db = pool) {
  const { rows } = await db.query(
    `select m.id as member_id, m."organizationId" as organization_id,
            m."userId" as user_id, m.role as auth_role,
            coalesce(mp.role, case when m.role = 'owner' then 'owner' else 'salesperson' end) as role,
            coalesce(mp.all_rooftops, false) as all_rooftops,
            coalesce(mp.status, 'active') as status
       from "member" m
       left join organization_member_profiles mp on mp.member_id = m.id
      where m."userId" = $1 and m."organizationId" = $2
      limit 1`,
    [userId, organizationId]
  );
  return rows[0] || null;
}

export async function requireMembership(userId, organizationId, db = pool) {
  const member = await getMembership(userId, organizationId, db);
  if (!member || member.status !== 'active') {
    throw new OrganizationAccessError('organization membership required');
  }
  return member;
}

export async function canAccessRooftop(member, dealershipId, db = pool) {
  if (!member || member.status !== 'active') return false;
  if (member.role === 'owner' || member.all_rooftops) {
    const { rows } = await db.query(
      `select 1 from organization_rooftops
        where organization_id = $1 and dealership_id = $2
          and status in ('reserved','active','past_due','suspended','pending_removal')`,
      [member.organization_id, dealershipId]
    );
    return rows.length > 0;
  }
  const { rows } = await db.query(
    `select 1 from member_rooftop_access a
       join organization_rooftops r
         on r.organization_id = a.organization_id and r.dealership_id = a.dealership_id
      where a.member_id = $1 and a.organization_id = $2 and a.dealership_id = $3
        and a.revoked_at is null
        and r.status in ('reserved','active','past_due','suspended','pending_removal')`,
    [member.member_id, member.organization_id, dealershipId]
  );
  return rows.length > 0;
}

export async function requireRooftopAccess(member, dealershipId, db = pool) {
  if (!(await canAccessRooftop(member, dealershipId, db))) {
    throw new OrganizationAccessError('rooftop access required', 403, 'wrong_rooftop');
  }
}

export function requireOwner(member) {
  if (!member || member.role !== 'owner') {
    throw new OrganizationAccessError('organization owner required', 403, 'owner_required');
  }
}

export async function requireTeamManagement(member, dealershipId, requestedRole, db = pool) {
  if (member.role === 'owner') return;
  if (member.role !== 'manager') {
    throw new OrganizationAccessError('team management permission required');
  }
  if (requestedRole && requestedRole !== 'salesperson') {
    throw new OrganizationAccessError('only owners can manage managers', 403, 'owner_required');
  }
  if (member.all_rooftops) {
    await requireRooftopAccess(member, dealershipId, db);
    return;
  }
  // A profile-level manager role does not grant management at every rooftop. The scoped
  // access row is the authority for this location and must itself carry manager privileges.
  const { rows } = await db.query(
    `select 1 from member_rooftop_access a
       join organization_rooftops r
         on r.organization_id=a.organization_id and r.dealership_id=a.dealership_id
      where a.member_id=$1 and a.organization_id=$2 and a.dealership_id=$3
        and a.role='manager' and a.revoked_at is null
        and r.status in ('reserved','active','past_due','suspended','pending_removal')`,
    [member.member_id, member.organization_id, dealershipId]
  );
  if (!rows.length) {
    throw new OrganizationAccessError('rooftop management access required', 403, 'wrong_rooftop');
  }
}

export async function hasActiveSeat(memberId, organizationId, dealershipId, db = pool) {
  const { rows } = await db.query(
    `select 1 from seat_assignments
      where member_id = $1 and organization_id = $2 and dealership_id = $3
        and released_at is null`,
    [memberId, organizationId, dealershipId]
  );
  return rows.length > 0;
}
