import crypto from 'node:crypto';
import { pool } from './db.js';
import { stripe as defaultStripeClient } from './stripe.js';
import { activateOrganizationClaims } from './claims.js';
import { getMembership } from './organization-authz.js';
import { recordOrganizationAudit } from './organization-audit.js';
import { reconcilePendingCapacity } from './capacity-billing.js';

const LIVE_STATUSES = new Set(['active', 'trialing']);
const TERMINAL_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const ORGANIZATION_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]);

export async function authorizeBillingReference({ user, referenceId, action }, db = pool) {
  const member = await getMembership(user.id, referenceId, db);
  if (!member || member.status !== 'active' || member.role !== 'owner') return false;
  if (action !== 'upgrade-subscription') return true;
  const { rows } = await db.query(
    `select 1 from dealership_claims
      where organization_id=$1 and status in ('approved','checkout_pending','active')
      limit 1`,
    [referenceId]
  );
  return rows.length > 0;
}

export async function organizationCheckoutTarget(userId, organizationId, db = pool) {
  const member = await getMembership(userId, organizationId, db);
  if (!member || member.status !== 'active' || member.role !== 'owner') {
    const err = new Error('organization owner required');
    err.status = 403;
    err.reason = 'owner_required';
    throw err;
  }
  const { rows } = await db.query(
    `select count(*) filter (where
              (
                r.status='reserved' and r.reservation_expires_at > now()
                and exists (
                  select 1 from dealership_claims c
                   where c.organization_id=r.organization_id
                     and c.dealership_id=r.dealership_id
                     and c.status in ('approved','checkout_pending')
                     and c.reservation_expires_at > now()
                )
              ) or (
                r.status in ('active','past_due','suspended')
                and exists (
                  select 1 from dealership_claims c
                   where c.organization_id=r.organization_id
                     and c.dealership_id=r.dealership_id and c.status='active'
                )
              )
            )::int as rooftop_count,
            count(*) filter (where
              r.status='reserved' and r.reservation_expires_at > now()
              and exists (
                select 1 from dealership_claims c
                 where c.organization_id=r.organization_id
                   and c.dealership_id=r.dealership_id
                   and c.status in ('approved','checkout_pending')
                   and c.reservation_expires_at > now()
              )
            )::int as reserved_count,
            count(*) filter (where
              r.status in ('active','past_due','suspended')
              and exists (
                select 1 from dealership_claims c
                 where c.organization_id=r.organization_id
                   and c.dealership_id=r.dealership_id and c.status='active'
              )
            )::int as active_claim_count,
            min(r.reservation_expires_at) filter (where
              r.status='reserved' and r.reservation_expires_at > now()
            ) as expires_at
       from organization_rooftops r
      where r.organization_id=$1`,
    [organizationId]
  );
  const rooftopCount = rows[0] ? rows[0].rooftop_count : 0;
  if (!rows[0] || (!rows[0].reserved_count && !rows[0].active_claim_count)) {
    const err = new Error('an approved dealership claim is required before checkout');
    err.status = 409;
    err.reason = 'claim_approval_required';
    throw err;
  }
  const reservationExpiresAt = rows[0].reserved_count && rows[0].expires_at
    ? new Date(rows[0].expires_at)
    : null;
  if (reservationExpiresAt && reservationExpiresAt.getTime() < Date.now() + 30 * 60 * 1000) {
    const err = new Error('claim reservation is too close to expiry; request a renewal');
    err.status = 409;
    err.reason = 'claim_reservation_expiring';
    throw err;
  }
  return { organizationId, rooftopCount, reservationExpiresAt };
}

async function organizationExists(referenceId, db) {
  const { rows } = await db.query('select 1 from "organization" where id=$1', [referenceId]);
  return rows.length > 0;
}

function subscriptionFields(subscription) {
  return {
    referenceId: subscription.referenceId,
    status: String(subscription.status || '').toLowerCase(),
    plan: String(subscription.plan || '').toLowerCase(),
    stripeSubscriptionId: subscription.stripeSubscriptionId || null,
    seats: Number(subscription.seats || 0)
  };
}

function stripeCustomerId(subscription) {
  const customer = subscription && subscription.customer;
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id || null;
}

function stripeDate(timestamp) {
  return timestamp ? new Date(timestamp * 1000) : null;
}

function stripePlanItem(subscription, priceId) {
  const items = subscription && subscription.items && Array.isArray(subscription.items.data)
    ? subscription.items.data
    : [];
  return items.find((item) => item.price && item.price.id === priceId) || null;
}

async function organizationSubscriptionRecord(stripeSubscription, db) {
  if (!stripeSubscription || !stripeSubscription.id) return null;
  const { rows: existingRows } = await db.query(
    `select s.* from "subscription" s
      join "organization" o on o.id=s."referenceId"
     where s."stripeSubscriptionId"=$1
     order by s."periodEnd" desc nulls first,s.id
     limit 1`,
    [stripeSubscription.id]
  );
  if (existingRows.length) return existingRows[0];

  // Better Auth normally creates this row before onEvent runs. Repair it here if its
  // internal handler failed after Stripe had already committed the subscription. The
  // customer must belong to an organization in this database and the configured rooftop
  // price must be present, so events for other products in the shared Stripe account are
  // ignored.
  const rooftopPriceId = process.env.STRIPE_DEALERSHIP_PRICE_ID || null;
  const rooftopItem = stripePlanItem(stripeSubscription, rooftopPriceId);
  const customerId = stripeCustomerId(stripeSubscription);
  if (!rooftopItem || !customerId) return null;
  const { rows: organizationRows } = await db.query(
    `select id from "organization" where "stripeCustomerId"=$1 limit 1`,
    [customerId]
  );
  if (!organizationRows.length) return null;

  const id = crypto.randomUUID();
  await db.query(
    `insert into "subscription" (
       id,plan,"referenceId","stripeCustomerId","stripeSubscriptionId",status,
       "periodStart","periodEnd","cancelAtPeriodEnd","cancelAt","canceledAt","endedAt",
       seats,"billingInterval"
     ) select $1,'dealership_rooftop',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
       where not exists (
         select 1 from "subscription" where "stripeSubscriptionId"=$4
       )
       on conflict do nothing`,
    [
      id,
      organizationRows[0].id,
      customerId,
      stripeSubscription.id,
      stripeSubscription.status || 'incomplete',
      stripeDate(rooftopItem.current_period_start ?? stripeSubscription.current_period_start),
      stripeDate(rooftopItem.current_period_end ?? stripeSubscription.current_period_end),
      Boolean(stripeSubscription.cancel_at_period_end),
      stripeDate(stripeSubscription.cancel_at),
      stripeDate(stripeSubscription.canceled_at),
      stripeDate(stripeSubscription.ended_at),
      Number(rooftopItem.quantity || 1),
      rooftopItem.price && rooftopItem.price.recurring
        ? rooftopItem.price.recurring.interval
        : null
    ]
  );
  const { rows } = await db.query(
    `select * from "subscription" where "stripeSubscriptionId"=$1
      order by "periodEnd" desc nulls first,id limit 1`,
    [stripeSubscription.id]
  );
  return rows[0] || null;
}

async function currentSubscriptionForEvent(event, stripeClient) {
  const raw = event && event.data && event.data.object;
  if (!raw) return null;
  let subscriptionId = null;
  if (event.type === 'checkout.session.completed') {
    subscriptionId = typeof raw.subscription === 'string'
      ? raw.subscription
      : raw.subscription && raw.subscription.id;
  } else {
    subscriptionId = raw.id;
  }
  if (!subscriptionId) return null;
  try {
    return await stripeClient.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent']
    });
  } catch (error) {
    if (event.type === 'customer.subscription.deleted' && error && error.code === 'resource_missing') {
      return raw;
    }
    throw error;
  }
}

// Better Auth's per-subscription handlers catch callback errors internally. Its top-level
// onEvent hook does not: an exception here makes the webhook fail so Stripe retries it.
// Always retrieve the current Stripe object first, which also makes stale/out-of-order event
// payloads converge on Stripe's latest state.
export async function reconcileOrganizationStripeEvent(event, {
  stripeClient = defaultStripeClient,
  db = pool
} = {}) {
  if (!event || !ORGANIZATION_EVENT_TYPES.has(event.type)) return { ignored: true };
  if (!event.id) {
    const error = new Error('Stripe event ID is required for idempotent reconciliation');
    error.code = 'stripe_event_id_required';
    throw error;
  }
  if (!stripeClient) throw new Error('Stripe is not configured');
  const runId = `stripe-event:${event.id}`;
  const { rows: prior } = await db.query(
    'select result from subscription_reconciliation_runs where id=$1',
    [runId]
  );
  if (prior.length) return { duplicate: true, result: prior[0].result };

  const stripeSubscription = await currentSubscriptionForEvent(event, stripeClient);
  if (!stripeSubscription) return { ignored: true };
  const subscription = await organizationSubscriptionRecord(stripeSubscription, db);
  if (!subscription) return { ignored: true };
  const synced = await syncOrganizationSubscription(subscription, {
    stripeSubscription,
    source: `stripe:event:${event.id}`,
    db
  });
  await db.query(
    `insert into subscription_reconciliation_runs (id,reference_id,stripe_customer_id,result,details)
     values ($1,$2,$3,'event_synced',$4) on conflict (id) do nothing`,
    [
      runId,
      subscription.referenceId,
      subscription.stripeCustomerId || stripeCustomerId(stripeSubscription),
      JSON.stringify({
        eventId: event.id,
        eventType: event.type,
        stripeSubscriptionId: stripeSubscription.id,
        status: synced.status,
        rooftopQuantity: synced.rooftopQuantity
      })
    ]
  );
  return { ignored: false, ...synced };
}

// Hourly source-of-truth repair. This is deliberately independent of webhook delivery and
// of the inventory scanner: a missed event, exhausted Stripe retries, or a temporary callback
// failure heals without a user opening the extension.
export async function reconcileOrganizationSubscriptions(db = pool, {
  stripeClient = defaultStripeClient,
  limit = 500
} = {}) {
  if (!stripeClient || !process.env.STRIPE_DEALERSHIP_PRICE_ID) {
    return { checked: 0, synced: 0, missing: 0, errors: [], skipped: 'billing_unavailable' };
  }
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const { rows } = await db.query(
    `select distinct on (s."stripeSubscriptionId") s.*
       from "subscription" s
       join organization_profiles p on p.organization_id=s."referenceId"
      where s.plan='dealership_rooftop' and s."stripeSubscriptionId" is not null
        and p.status<>'archived'
      order by s."stripeSubscriptionId",
        (s.status in ('active','trialing','past_due','incomplete','unpaid')) desc,
        s."periodEnd" desc nulls first
      limit $1`,
    [safeLimit]
  );
  const result = { checked: rows.length, synced: 0, missing: 0, errors: [] };
  for (const subscription of rows) {
    try {
      let stripeSubscription;
      try {
        stripeSubscription = await stripeClient.subscriptions.retrieve(
          subscription.stripeSubscriptionId,
          { expand: ['latest_invoice.payment_intent'] }
        );
      } catch (error) {
        if (!error || error.code !== 'resource_missing') throw error;
        result.missing += 1;
        stripeSubscription = {
          id: subscription.stripeSubscriptionId,
          status: 'canceled',
          customer: subscription.stripeCustomerId,
          items: null
        };
      }
      await syncOrganizationSubscription(subscription, {
        stripeSubscription,
        source: 'stripe:scheduled-reconciliation',
        db
      });
      result.synced += 1;
    } catch (error) {
      result.errors.push({
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        code: error && (error.code || error.type) ? String(error.code || error.type) : 'reconcile_failed'
      });
    }
  }
  await db.query(
    `insert into subscription_reconciliation_runs (id,result,details)
     values ($1,$2,$3)`,
    [
      crypto.randomUUID(),
      result.errors.length ? 'partial' : 'ok',
      JSON.stringify(result)
    ]
  );
  return result;
}

export async function pruneSubscriptionReconciliationRuns(
  db = pool,
  { now = new Date(), retentionDays = 180 } = {}
) {
  const days = Math.max(30, Math.min(730, Math.floor(Number(retentionDays) || 180)));
  const cutoff = new Date(new Date(now).getTime() - days * 24 * 60 * 60 * 1000);
  const { rowCount } = await db.query(
    'delete from subscription_reconciliation_runs where created_at < $1',
    [cutoff.toISOString()]
  );
  return rowCount;
}

export async function syncOrganizationSubscription(subscription, {
  stripeSubscription = null,
  source = 'stripe:webhook',
  db = pool
} = {}) {
  const fields = subscriptionFields({
    ...subscription,
    status: (stripeSubscription && stripeSubscription.status) || subscription.status,
    stripeSubscriptionId: subscription.stripeSubscriptionId
      || (stripeSubscription && stripeSubscription.id)
  });
  if (!fields.referenceId || fields.plan !== 'dealership_rooftop') return { organization: false };
  if (!(await organizationExists(fields.referenceId, db))) return { organization: false };

  const rooftopPriceId = process.env.STRIPE_DEALERSHIP_PRICE_ID || null;
  const extraSeatPriceId = process.env.STRIPE_EXTRA_SEAT_PRICE_ID || null;
  const hasStripeItems = Boolean(stripeSubscription && stripeSubscription.items);
  const rooftopItem = hasStripeItems
    ? stripeSubscription.items.data.find((item) => item.price && item.price.id === rooftopPriceId)
    : null;
  const extraSeatItem = hasStripeItems && extraSeatPriceId
    ? stripeSubscription.items.data.find((item) => item.price && item.price.id === extraSeatPriceId)
    : null;
  const quantity = Math.max(0, rooftopItem ? Number(rooftopItem.quantity || 0) : fields.seats);
  const extraSeatQuantity = extraSeatItem ? Number(extraSeatItem.quantity || 0) : 0;

  if (stripeSubscription && fields.stripeSubscriptionId) {
    const date = (timestamp) => (timestamp ? new Date(timestamp * 1000) : null);
    const periodStart = rooftopItem && rooftopItem.current_period_start != null
      ? date(rooftopItem.current_period_start)
      : date(stripeSubscription.current_period_start);
    const periodEnd = rooftopItem && rooftopItem.current_period_end != null
      ? date(rooftopItem.current_period_end)
      : date(stripeSubscription.current_period_end);
    await db.query(
      `update "subscription" set status=$2,
         "periodStart"=coalesce($3,"periodStart"),"periodEnd"=coalesce($4,"periodEnd"),
         "cancelAtPeriodEnd"=$5,"cancelAt"=$6,"canceledAt"=$7,"endedAt"=$8,
         seats=$9,"billingInterval"=coalesce($10,"billingInterval")
        where "stripeSubscriptionId"=$1`,
      [
        fields.stripeSubscriptionId,
        fields.status,
        periodStart,
        periodEnd,
        Boolean(stripeSubscription.cancel_at_period_end),
        date(stripeSubscription.cancel_at),
        date(stripeSubscription.canceled_at),
        date(stripeSubscription.ended_at),
        quantity,
        rooftopItem && rooftopItem.price && rooftopItem.price.recurring
          ? rooftopItem.price.recurring.interval
          : null
      ]
    );
  }

  if (LIVE_STATUSES.has(fields.status)) {
    await activateOrganizationClaims(fields.referenceId, db, { paidRooftopQuantity: quantity });
  } else if (fields.status === 'past_due') {
    await db.query(
      `update organization_profiles set status='past_due',
         grace_ends_at=coalesce(grace_ends_at,now()+interval '3 days'), suspended_at=null,
         updated_at=now()
        where organization_id=$1`,
      [fields.referenceId]
    );
    await db.query(
      `update workspaces set status='past_due', updated_at=now() where organization_id=$1`,
      [fields.referenceId]
    );
    await db.query(
      `update organization_rooftops set status='past_due', updated_at=now()
        where organization_id=$1 and status='active'`,
      [fields.referenceId]
    );
  } else if (TERMINAL_STATUSES.has(fields.status)) {
    await db.query(
      `update organization_profiles set status='suspended', grace_ends_at=null,
         suspended_at=coalesce(suspended_at,now()), updated_at=now()
        where organization_id=$1`,
      [fields.referenceId]
    );
    await db.query(
      `update workspaces set status='suspended', updated_at=now() where organization_id=$1`,
      [fields.referenceId]
    );
    await db.query(
      `update organization_rooftops set status='suspended', updated_at=now()
        where organization_id=$1 and status in ('reserved','active','past_due','pending_removal')`,
      [fields.referenceId]
    );
  }

  await db.query(
    `insert into organization_billing_items (
       organization_id, stripe_subscription_id, rooftop_item_id, rooftop_quantity,
       extra_seat_item_id, extra_seat_quantity, synced_at
     ) values ($1,$2,$3,$4,$5,$6,now())
     on conflict (organization_id) do update set
       stripe_subscription_id=excluded.stripe_subscription_id,
       rooftop_item_id=coalesce(excluded.rooftop_item_id,organization_billing_items.rooftop_item_id),
       rooftop_quantity=case when $7 then excluded.rooftop_quantity
         else organization_billing_items.rooftop_quantity end,
       extra_seat_item_id=coalesce(excluded.extra_seat_item_id,organization_billing_items.extra_seat_item_id),
       extra_seat_quantity=case when $7 then excluded.extra_seat_quantity
         else organization_billing_items.extra_seat_quantity end,
       synced_at=now(), updated_at=now()`,
    [
      fields.referenceId,
      fields.stripeSubscriptionId,
      rooftopItem && rooftopItem.id,
      Math.max(0, quantity),
      extraSeatItem && extraSeatItem.id,
      Math.max(0, extraSeatQuantity),
      hasStripeItems
    ]
  );
  const capacity = LIVE_STATUSES.has(fields.status)
    ? await reconcilePendingCapacity(fields.referenceId, stripeSubscription, db)
    : { applied: 0 };
  await recordOrganizationAudit({
    organizationId: fields.referenceId,
    actorUserId: source,
    action: 'billing.subscription_synced',
    targetType: 'subscription',
    targetId: fields.stripeSubscriptionId,
    data: { status: fields.status, plan: fields.plan, rooftopQuantity: quantity }
  }, db);
  return {
    organization: true,
    status: fields.status,
    rooftopQuantity: quantity,
    capacityApplied: capacity.applied
  };
}

export async function enforceOrganizationBillingLifecycle(db = pool) {
  const { rows: graceExpired } = await db.query(
    `update organization_profiles set status='suspended', suspended_at=coalesce(suspended_at,now()),
       grace_ends_at=null, updated_at=now()
      where status='past_due' and grace_ends_at <= now()
      returning organization_id`
  );
  for (const row of graceExpired) {
    await db.query(
      `update workspaces set status='suspended', updated_at=now() where organization_id=$1`,
      [row.organization_id]
    );
    await db.query(
      `update organization_rooftops set status='suspended', updated_at=now()
        where organization_id=$1 and status in ('reserved','active','past_due','pending_removal')`,
      [row.organization_id]
    );
  }

  const { rows: archived } = await db.query(
    `update organization_profiles set status='archived', archived_at=now(), updated_at=now()
      where status='suspended' and suspended_at <= now()-interval '90 days'
      returning organization_id`
  );
  for (const row of archived) {
    await db.query(
      `update workspaces set status='archived', updated_at=now() where organization_id=$1`,
      [row.organization_id]
    );
    await db.query(
      `update organization_rooftops set status='archived', archived_at=now(), updated_at=now()
        where organization_id=$1 and status<>'archived'`,
      [row.organization_id]
    );
    // Archiving releases the rooftop for a future verified claimant. The partial unique
    // index on active claims would otherwise keep the old organization as a permanent ghost
    // owner even though its rooftop row is reclaimable.
    await db.query(
      `update dealership_claims set status='suspended',reviewed_by='system:billing-archive',
         reviewed_at=now(),review_reason='Organization archived after billing retention window',
         reservation_expires_at=null,updated_at=now()
        where organization_id=$1 and status in ('approved','checkout_pending','active')`,
      [row.organization_id]
    );
    await recordOrganizationAudit({
      organizationId: row.organization_id,
      actorUserId: 'system:billing-archive',
      action: 'organization.archived',
      targetType: 'organization',
      targetId: row.organization_id
    }, db);
  }
  return { graceExpired: graceExpired.length, archived: archived.length };
}

export function checkoutExpiry(reservationExpiresAt, now = Date.now()) {
  const latest = now + 24 * 60 * 60 * 1000;
  return Math.floor(Math.min(latest, new Date(reservationExpiresAt).getTime()) / 1000);
}

export { LIVE_STATUSES, TERMINAL_STATUSES };
