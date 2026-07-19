import { pool } from './db.js';
import { requireMembership, requireRooftopAccess } from './organization-authz.js';
import { organizationPaidState } from './entitlement/index.js';

function dashboardError(message, status = 400, reason = 'invalid_request') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

export function dashboardRange({ from = null, to = null } = {}, now = new Date()) {
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw dashboardError('invalid dashboard date range', 400, 'invalid_date_range');
  }
  const earliest = new Date(end.getTime() - 366 * 24 * 60 * 60 * 1000);
  return {
    from: (start < earliest ? earliest : start).toISOString(),
    to: end.toISOString()
  };
}

async function allowedRooftops(member, organizationId, db) {
  if (member.role === 'owner' || member.all_rooftops) {
    const { rows } = await db.query(
      `select r.dealership_id, d.name
         from organization_rooftops r join dealerships d on d.id=r.dealership_id
        where r.organization_id=$1 and r.status in ('active','past_due','suspended','pending_removal')
        order by d.name`,
      [organizationId]
    );
    return rows;
  }
  const { rows } = await db.query(
    `select a.dealership_id, d.name
       from member_rooftop_access a
       join organization_rooftops r on r.organization_id=a.organization_id
        and r.dealership_id=a.dealership_id
        and r.status in ('active','past_due','suspended','pending_removal')
       join dealerships d on d.id=a.dealership_id
      where a.member_id=$1 and a.organization_id=$2 and a.revoked_at is null
      order by d.name`,
    [member.member_id, organizationId]
  );
  return rows;
}

function number(value) {
  return Number(value || 0);
}

export async function getOrganizationDashboard(userId, organizationId, filters = {}, db = pool) {
  const member = await requireMembership(userId, organizationId, db);
  const paid = await organizationPaidState(organizationId, db);
  if (!paid.paid) throw dashboardError('subscription required', 402, paid.reason);
  const range = dashboardRange(filters);
  const rooftops = await allowedRooftops(member, organizationId, db);
  if (!rooftops.length) throw dashboardError('no accessible rooftops', 403, 'wrong_rooftop');

  let dealershipIds = rooftops.map((row) => row.dealership_id);
  if (filters.dealershipId) {
    await requireRooftopAccess(member, filters.dealershipId, db);
    dealershipIds = [filters.dealershipId];
  }

  let actorUserId = null;
  if (member.role === 'salesperson') actorUserId = userId;
  if (filters.memberId) {
    if (member.role === 'salesperson' && filters.memberId !== member.member_id) {
      throw dashboardError('member filter is outside your scope', 403, 'forbidden');
    }
    const { rows } = await db.query(
      `select m."userId" as user_id
         from "member" m
         left join organization_member_profiles mp on mp.member_id=m.id
         left join member_rooftop_access a on a.member_id=m.id and a.revoked_at is null
        where m.id=$1 and m."organizationId"=$2
          and ($3='owner' or m.id=$5 or (
            $3='manager'
            and coalesce(mp.role,case when m.role='owner' then 'owner' else 'salesperson' end)='salesperson'
            and a.dealership_id=any($4)
          ))
        limit 1`,
      [filters.memberId, organizationId, member.role, dealershipIds, member.member_id]
    );
    if (!rows.length) throw dashboardError('member filter is outside your scope', 403, 'forbidden');
    actorUserId = rows[0].user_id;
  }

  const workspaceId = `organization:${organizationId}`;
  const listingParams = [workspaceId, dealershipIds, range.from, range.to, actorUserId];
  const { rows: metricRows } = await db.query(
    `select
       count(*) filter (
         where coalesce(listed_at,created_at) between $3 and $4
       )::int as listing_actions,
       count(distinct coalesce(vin,client_key)) filter (
         where coalesce(listed_at,created_at) between $3 and $4
       )::int as unique_vehicles,
       count(distinct coalesce(vin,client_key)) filter (
         where status='listed' and dealer_outcome is null
       )::int as currently_listed,
       count(distinct coalesce(vin,client_key)) filter (
         where status='sold' and sold_source='scan' and sold_at between $3 and $4
       )::int as sold_at_dealership,
       avg(extract(epoch from (sold_at-coalesce(listed_at,created_at)))/86400.0)
         filter (where status='sold' and sold_source='scan'
           and sold_at between $3 and $4)::numeric as avg_days_to_sale,
       sum(views_count) filter (
         where views_count is not null and coalesce(listed_at,created_at) between $3 and $4
       )::bigint as observed_views,
       count(*) filter (
         where views_count is not null and coalesce(listed_at,created_at) between $3 and $4
       )::int as listings_with_views,
       max(views_observed_at) filter (
         where coalesce(listed_at,created_at) between $3 and $4
       ) as views_last_observed_at
     from listings
     where workspace_id=$1 and dealership_id=any($2)
       and ($5::text is null or actor_user_id=$5)`,
    listingParams
  );
  const metrics = metricRows[0];
  const withViews = number(metrics.listings_with_views);
  const listingActions = number(metrics.listing_actions);
  const observedViews = metrics.observed_views == null ? null : number(metrics.observed_views);

  const { rows: publishRows } = await db.query(
    `select count(*)::int as count from usage_events
      where workspace_id=$1 and type='publish_detected'
        and occurred_at between $3 and $4
        and ($5::text is null or actor_user_id=$5)
        and exists (
          select 1 from listings l where l.workspace_id=usage_events.workspace_id
            and l.actor_user_id=usage_events.actor_user_id
            and l.client_key=usage_events.client_key
            and l.dealership_id=any($2)
        )`,
    listingParams
  );

  const { rows: memberRows } = await db.query(
    `select m.id as member_id, u.name, u.email, mp.role,
            count(l.id) filter (
              where coalesce(l.listed_at,l.created_at) between $3 and $4
            )::int as listing_actions,
            count(distinct coalesce(l.vin,l.client_key)) filter (
              where coalesce(l.listed_at,l.created_at) between $3 and $4
            )::int as unique_vehicles,
            count(distinct coalesce(l.vin,l.client_key)) filter (
              where l.status='sold' and l.sold_source='scan' and l.sold_at between $3 and $4
            )::int as sold_at_dealership,
            sum(l.views_count) filter (
              where l.views_count is not null
                and coalesce(l.listed_at,l.created_at) between $3 and $4
            )::bigint as observed_views,
            count(l.id) filter (
              where l.views_count is not null
                and coalesce(l.listed_at,l.created_at) between $3 and $4
            )::int as listings_with_views,
            max(coalesce(l.listed_at,l.created_at)) as last_activity_at
       from "member" m
       join "user" u on u.id=m."userId"
       left join organization_member_profiles mp on mp.member_id=m.id
       left join listings l on l.workspace_id=$1 and l.actor_user_id=m."userId"
         and l.dealership_id=any($2)
      where m."organizationId"=$6
        and coalesce(mp.status,'active') <> 'removed'
        and ($5::text is null or m."userId"=$5)
        and (
          $7='owner'
          or m.id=$8
          or ($7='manager'
            and coalesce(mp.role,case when m.role='owner' then 'owner' else 'salesperson' end)='salesperson'
            and exists (
              select 1 from member_rooftop_access visible_access
               where visible_access.member_id=m.id and visible_access.revoked_at is null
                 and visible_access.dealership_id=any($2)
            )
          )
        )
      group by m.id,u.id,mp.role
      order by listing_actions desc,u.name,u.email`,
    [...listingParams, organizationId, member.role, member.member_id]
  );

  const { rows: capacityRows } = await db.query(
    `select r.dealership_id, d.name,r.status,r.removal_effective_at,
            r.included_seats,r.extra_seats,r.requested_extra_seats,r.capacity_change_effective_at,
            r.included_seats+r.extra_seats as purchased,
            (select count(*)::int from seat_assignments s
              where s.organization_id=r.organization_id and s.dealership_id=r.dealership_id
                and s.released_at is null) as assigned,
            (select count(*)::int from seat_reservations sr
              where sr.organization_id=r.organization_id and sr.dealership_id=r.dealership_id
                and sr.released_at is null and sr.expires_at > now()) as reserved
       from organization_rooftops r
       join dealerships d on d.id=r.dealership_id
      where r.organization_id=$1 and r.dealership_id=any($2)
      order by d.name`,
    [organizationId, dealershipIds]
  );

  const { rows: recentListings } = await db.query(
    `select l.id,l.actor_user_id,u.name as actor_name,l.dealership_id,d.name as dealership_name,
            l.vin,l.title,l.status,l.sold_source,l.listed_at,l.sold_at,
            l.views_count,l.views_observed_at,l.facebook_listing_url
       from listings l
       join "user" u on u.id=l.actor_user_id
       join dealerships d on d.id=l.dealership_id
      where l.workspace_id=$1 and l.dealership_id=any($2)
        and ($3::text is null or l.actor_user_id=$3)
      order by coalesce(l.listed_at,l.created_at) desc limit 50`,
    [workspaceId, dealershipIds, actorUserId]
  );

  return {
    organizationId,
    role: member.role,
    range,
    filters: { dealershipIds, memberId: filters.memberId || null },
    rooftops,
    metrics: {
      listingActions,
      publishEvents: number(publishRows[0].count),
      uniqueVehicles: number(metrics.unique_vehicles),
      currentlyListed: number(metrics.currently_listed),
      soldAtDealership: number(metrics.sold_at_dealership),
      averageDaysToSale: metrics.avg_days_to_sale == null ? null : Number(Number(metrics.avg_days_to_sale).toFixed(1)),
      observedViews,
      viewsPerListing: observedViews == null || !listingActions
        ? null
        : Number((observedViews / listingActions).toFixed(1)),
      viewsPerObservedListing: withViews ? Number((observedViews / withViews).toFixed(1)) : null,
      viewCoverage: listingActions ? Number((withViews / listingActions).toFixed(3)) : null,
      viewsLastObservedAt: metrics.views_last_observed_at || null
    },
    capacity: capacityRows.map((row) => ({
      dealershipId: row.dealership_id,
      dealershipName: row.name,
      status: row.status,
      removalEffectiveAt: row.removal_effective_at || null,
      includedSeats: number(row.included_seats),
      extraSeats: number(row.extra_seats),
      requestedExtraSeats: row.requested_extra_seats == null ? null : number(row.requested_extra_seats),
      capacityChangeEffectiveAt: row.capacity_change_effective_at || null,
      purchased: number(row.purchased),
      assigned: number(row.assigned),
      reserved: number(row.reserved)
    })),
    members: memberRows.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      email: row.email,
      role: row.role,
      listingActions: number(row.listing_actions),
      uniqueVehicles: number(row.unique_vehicles),
      soldAtDealership: number(row.sold_at_dealership),
      observedViews: row.observed_views == null ? null : number(row.observed_views),
      viewsPerListing: row.observed_views == null || !number(row.listing_actions)
        ? null
        : Number((number(row.observed_views) / number(row.listing_actions)).toFixed(1)),
      viewCoverage: number(row.listing_actions)
        ? Number((number(row.listings_with_views) / number(row.listing_actions)).toFixed(3))
        : null,
      lastActivityAt: row.last_activity_at || null
    })),
    recentListings
  };
}
