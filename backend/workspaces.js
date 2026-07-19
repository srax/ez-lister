import { pool } from './db.js';
import { hostMatchesDomains } from './dealer-url.js';

export function personalWorkspaceId(userId) {
  return `personal:${userId}`;
}

export async function ensurePersonalWorkspace(userId, db = pool) {
  const id = personalWorkspaceId(userId);
  await db.query(
    `insert into workspaces (id, type, user_id, status)
     select $1, 'personal', $2, 'active'
     where exists (select 1 from "user" where id = $2)
     on conflict do nothing`,
    [id, userId]
  );
  return id;
}

function dealershipFromRow(row) {
  if (!row || !row.dealership_id) return null;
  const config = row.dealership_config || {};
  return {
    id: row.dealership_id,
    name: row.dealership_name,
    platform: row.dealership_platform,
    timezone: row.dealership_timezone,
    location: config.location || null,
    domains: row.dealership_domains || [],
    config: {
      location: config.location || null,
      sitemapUrl: config.sitemapUrl || null,
      inventoryUrls: config.inventoryUrls || []
    }
  };
}

export async function listUserWorkspaces(userId, db = pool) {
  const personalId = await ensurePersonalWorkspace(userId, db);
  const { rows: personalRows } = await db.query(
    `select w.id, w.status,
            d.id as dealership_id, d.name as dealership_name, d.platform as dealership_platform,
            d.timezone as dealership_timezone, d.config as dealership_config,
            case when d.id is null then array[]::text[] else array(
              select da.domain from dealership_aliases da where da.dealership_id = d.id
            ) end as dealership_domains
       from workspaces w
       left join user_dealerships ud on ud.user_id = w.user_id
       left join dealerships d on d.id = ud.dealership_id
      where w.id = $1 and w.user_id = $2`,
    [personalId, userId]
  );

  const workspaces = [];
  if (personalRows.length) {
    workspaces.push({
      id: personalRows[0].id,
      type: 'personal',
      status: personalRows[0].status,
      organization: null,
      member: null,
      rooftops: personalRows[0].dealership_id
        ? [{ dealership: dealershipFromRow(personalRows[0]), role: 'personal', hasSeat: true }]
        : []
    });
  }

  const { rows: memberships } = await db.query(
    `select w.id as workspace_id, w.status as workspace_status,
            o.id as organization_id, o.name as organization_name, o.slug as organization_slug,
            m.id as member_id, m.role as auth_role,
            coalesce(mp.role, case when m.role = 'owner' then 'owner' else 'salesperson' end) as role,
            coalesce(mp.all_rooftops, false) as all_rooftops,
            coalesce(mp.status, 'active') as member_status,
            mp.listing_preference
       from "member" m
       join "organization" o on o.id = m."organizationId"
       join workspaces w on w.organization_id = o.id and w.type = 'organization'
       left join organization_member_profiles mp on mp.member_id = m.id
      where m."userId" = $1
        and coalesce(mp.status, 'active') <> 'removed'
      order by o.name, o.id`,
    [userId]
  );

  if (!memberships.length) return workspaces;
  const organizationIds = memberships.map((m) => m.organization_id);
  const memberIds = memberships.map((m) => m.member_id);
  const { rows: rooftopRows } = await db.query(
    `select r.organization_id, r.dealership_id, r.status as rooftop_status,
            d.name as dealership_name, d.platform as dealership_platform,
            d.timezone as dealership_timezone, d.config as dealership_config,
            array(select da.domain from dealership_aliases da where da.dealership_id = d.id) as dealership_domains,
            m.id as member_id, a.role as access_role,
            (a.member_id is not null) as has_access,
            exists (
              select 1 from seat_assignments s
               where s.organization_id = r.organization_id
                 and s.dealership_id = r.dealership_id
                 and s.member_id = m.id
                 and s.released_at is null
            ) as has_seat
       from organization_rooftops r
       join dealerships d on d.id = r.dealership_id
       join "member" m
         on m."organizationId" = r.organization_id
        and m.id = any($2)
       left join member_rooftop_access a
         on a.organization_id = r.organization_id
        and a.dealership_id = r.dealership_id
        and a.member_id = m.id
        and a.revoked_at is null
      where r.organization_id = any($1)
        and r.status in ('reserved', 'active', 'past_due', 'suspended', 'pending_removal')
      order by d.name, d.id`,
    [organizationIds, memberIds]
  );

  for (const membership of memberships) {
    const owner = membership.role === 'owner';
    const rooftops = rooftopRows
      .filter((r) => r.organization_id === membership.organization_id)
      .filter((r) => owner || membership.all_rooftops || r.has_access)
      .map((r) => ({
        dealership: dealershipFromRow(r),
        status: r.rooftop_status,
        role: owner ? 'owner' : (r.access_role || membership.role),
        hasSeat: Boolean(r.has_seat)
      }));
    workspaces.push({
      id: membership.workspace_id,
      type: 'organization',
      status: membership.workspace_status,
      organization: {
        id: membership.organization_id,
        name: membership.organization_name,
        slug: membership.organization_slug
      },
      member: {
        id: membership.member_id,
        role: membership.role,
        allRooftops: Boolean(membership.all_rooftops),
        status: membership.member_status,
        listingPreference: membership.listing_preference || null
      },
      rooftops
    });
  }
  return workspaces;
}

function workspaceMatchesHost(workspace, host) {
  return workspace.rooftops.some((r) => hostMatchesDomains(host, r.dealership.domains || []));
}

export function selectWorkspace(workspaces, { requestedId = null, host = null } = {}) {
  const available = (workspaces || []).filter((w) => w.status !== 'archived');
  if (requestedId) return available.find((w) => w.id === requestedId) || null;

  if (host) {
    const matching = available.filter((w) => workspaceMatchesHost(w, host));
    const organizationsWithSeats = matching.filter((w) =>
      w.type === 'organization'
      && w.rooftops.some((r) => r.hasSeat && hostMatchesDomains(host, r.dealership.domains || []))
    );
    if (organizationsWithSeats.length === 1) return organizationsWithSeats[0];
    if (organizationsWithSeats.length > 1) return null;
    const matchingPersonal = matching.filter((w) => w.type === 'personal');
    if (matchingPersonal.length === 1) return matchingPersonal[0];
    if (matchingPersonal.length > 1) return null;
    if (matching.length === 1) return matching[0];
    if (matching.length > 1) return null;
  }

  return available.find((w) => w.type === 'personal') || available[0] || null;
}

export function selectRooftop(workspace, { dealershipId = null, host = null } = {}) {
  if (!workspace) return null;
  const rooftops = workspace.rooftops || [];
  if (dealershipId) {
    return rooftops.find((item) => item.dealership && item.dealership.id === dealershipId) || null;
  }
  if (host) {
    const matching = rooftops.filter((item) =>
      item.dealership && hostMatchesDomains(host, item.dealership.domains || [])
    );
    return matching.length === 1 ? matching[0] : null;
  }
  return rooftops.length === 1 ? rooftops[0] : null;
}

export async function getWorkspaceContext(userId, options = {}, db = pool) {
  const workspaces = await listUserWorkspaces(userId, db);
  const selected = selectWorkspace(workspaces, options);
  const rooftop = selectRooftop(selected, options);
  return { workspaces, selected, rooftop };
}
