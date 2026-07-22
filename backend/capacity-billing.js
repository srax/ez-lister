import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { stripe } from './stripe.js';
import { requireMembership, requireOwner } from './organization-authz.js';
import { activateWaitingRequests } from './organizations.js';
import { recordOrganizationAudit } from './organization-audit.js';

function capacityError(message, status = 400, reason = 'invalid_capacity') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function idempotencyKey(parts) {
  return `carxpert-capacity-${crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32)}`;
}

export function capacityChangeKind(effectiveExtraSeats, requestedExtraSeats) {
  if (requestedExtraSeats > effectiveExtraSeats) return 'increase';
  if (requestedExtraSeats < effectiveExtraSeats) return 'reduction';
  return 'cancel_reduction';
}

function findExtraSeatItem(subscription, itemId, priceId) {
  const items = subscription && subscription.items ? subscription.items.data || [] : [];
  return items.find((item) => item.id === itemId)
    || items.find((item) => item.price && item.price.id === priceId)
    || null;
}

async function writeStripeQuantity({
  stripeClient,
  subscriptionId,
  item,
  priceId,
  quantity,
  prorationBehavior,
  paymentBehavior = null,
  key
}) {
  const behavior = paymentBehavior ? { payment_behavior: paymentBehavior } : {};
  if (quantity > 0 && item) {
    await stripeClient.subscriptionItems.update(item.id, {
      quantity,
      proration_behavior: prorationBehavior,
      ...behavior
    }, { idempotencyKey: key });
    return item.id;
  }
  if (quantity > 0) {
    const created = await stripeClient.subscriptionItems.create({
      subscription: subscriptionId,
      price: priceId,
      quantity,
      proration_behavior: prorationBehavior,
      ...behavior
    }, { idempotencyKey: key });
    return created.id;
  }
  if (item) {
    await stripeClient.subscriptionItems.del(item.id, {
      proration_behavior: prorationBehavior
    }, { idempotencyKey: key });
  }
  return null;
}

export async function changeRooftopCapacity(
  userId,
  organizationId,
  dealershipId,
  requestedExtraSeats,
  db = pool,
  options = {}
) {
  const stripeClient = options.stripeClient === undefined ? stripe : options.stripeClient;
  const extraSeatPriceId = options.extraSeatPriceId || process.env.STRIPE_EXTRA_SEAT_PRICE_ID;
  if (!stripeClient || !extraSeatPriceId) {
    throw capacityError('extra-seat billing is not configured', 503, 'billing_unavailable');
  }
  const requested = Number(requestedExtraSeats);
  if (!Number.isInteger(requested) || requested < 0 || requested > 500) {
    throw capacityError('extraSeats must be an integer between 0 and 500');
  }

  const result = await withTransaction(async (tx) => {
    const actor = await requireMembership(userId, organizationId, tx);
    requireOwner(actor);
    const { rows: rooftopRows } = await tx.query(
      `select * from organization_rooftops
        where organization_id=$1 and dealership_id=$2 and status in ('active','past_due')
        for update`,
      [organizationId, dealershipId]
    );
    const rooftop = rooftopRows[0];
    if (!rooftop) throw capacityError('active rooftop not found', 404, 'wrong_rooftop');
    const assignedResult = await tx.query(
      `select count(*)::int as count from seat_assignments
        where organization_id=$1 and dealership_id=$2 and released_at is null`,
      [organizationId, dealershipId]
    );
    const reservedResult = await tx.query(
      `select count(*)::int as count from seat_reservations
        where organization_id=$1 and dealership_id=$2
          and released_at is null and expires_at > now()`,
      [organizationId, dealershipId]
    );
    const used = assignedResult.rows[0].count + reservedResult.rows[0].count;
    const minimumExtra = Math.max(0, used - rooftop.included_seats);
    if (requested < minimumExtra) {
      throw capacityError(
        `release seats or reservations before reducing below ${minimumExtra} extra seats`,
        409,
        'capacity_in_use'
      );
    }
    const effectiveExtra = rooftop.extra_seats;
    const currentRequested = rooftop.requested_extra_seats == null
      ? effectiveExtra
      : rooftop.requested_extra_seats;
    if (requested === currentRequested) {
      return {
        changed: false,
        effectiveExtra,
        requestedExtra: currentRequested,
        pending: currentRequested > effectiveExtra
      };
    }

    const { rows: pendingIncreases } = await tx.query(
      `select dealership_id from organization_rooftops
        where organization_id=$1 and requested_extra_seats > extra_seats
          and dealership_id <> $2 limit 1`,
      [organizationId, dealershipId]
    );
    if (pendingIncreases.length) {
      throw capacityError('another seat increase is awaiting Stripe confirmation', 409, 'capacity_change_pending');
    }

    const { rows: subscriptionRows } = await tx.query(
      `select * from "subscription"
        where "referenceId"=$1 and plan='dealership_rooftop'
          and status in ('active','trialing','past_due')
        order by ("periodEnd" is null or "periodEnd">now()) desc,"periodEnd" desc nulls first
        limit 1 for update`,
      [organizationId]
    );
    const subscription = subscriptionRows[0];
    if (!subscription || !subscription.stripeSubscriptionId) {
      throw capacityError('active organization subscription not found', 409, 'no_subscription');
    }
    const kind = capacityChangeKind(effectiveExtra, requested);
    const increasing = kind === 'increase';
    let targetTotal = null;
    let extraItemId = null;
    let effectiveAt = null;
    let increaseConfirmed = false;
    if (increasing) {
      // Stripe still carries effective capacity. Pending reductions are intentionally not
      // sent to Stripe until renewal, so an increase is charged only above today's access.
      const { rows: totals } = await tx.query(
        `select coalesce(sum(extra_seats),0)::int as total
           from organization_rooftops
          where organization_id=$1 and status in ('active','past_due','pending_removal')`,
        [organizationId]
      );
      targetTotal = totals[0].total - effectiveExtra + requested;
      const { rows: billingRows } = await tx.query(
        `select * from organization_billing_items where organization_id=$1 for update`,
        [organizationId]
      );
      const billing = billingRows[0] || {};
      const stripeSubscription = await stripeClient.subscriptions.retrieve(
        subscription.stripeSubscriptionId
      );
      const extraItem = findExtraSeatItem(
        stripeSubscription,
        billing.extra_seat_item_id,
        extraSeatPriceId
      );
      const key = idempotencyKey([
        organizationId,
        dealershipId,
        effectiveExtra,
        requested,
        subscription.stripeSubscriptionId
      ]);
      extraItemId = await writeStripeQuantity({
        stripeClient,
        subscriptionId: subscription.stripeSubscriptionId,
        item: extraItem,
        priceId: extraSeatPriceId,
        quantity: targetTotal,
        prorationBehavior: 'always_invoice',
        paymentBehavior: 'pending_if_incomplete',
        key
      });
      const confirmedSubscription = await stripeClient.subscriptions.retrieve(
        subscription.stripeSubscriptionId
      );
      const confirmedItem = findExtraSeatItem(confirmedSubscription, extraItemId, extraSeatPriceId);
      const confirmed = Boolean(
        confirmedItem
        && Number(confirmedItem.quantity || 0) === targetTotal
        && !confirmedSubscription.pending_update
      );
      increaseConfirmed = confirmed;
      await tx.query(
        `update organization_rooftops set
           extra_seats=case when $4 then $3 else extra_seats end,
           requested_extra_seats=case when $4 then null else $3 end,
           capacity_change_effective_at=null,updated_at=now()
          where organization_id=$1 and dealership_id=$2`,
        [organizationId, dealershipId, requested, confirmed]
      );
      await tx.query(
        `insert into organization_billing_items (
           organization_id,stripe_subscription_id,extra_seat_item_id,extra_seat_quantity,synced_at
         ) values ($1,$2,$3,$4,now())
         on conflict (organization_id) do update set
           stripe_subscription_id=excluded.stripe_subscription_id,
           extra_seat_item_id=excluded.extra_seat_item_id,
           extra_seat_quantity=excluded.extra_seat_quantity,
           synced_at=now(),updated_at=now()`,
        [
          organizationId,
          subscription.stripeSubscriptionId,
          extraItemId,
          confirmed ? targetTotal : targetTotal - requested + effectiveExtra
        ]
      );
    } else if (kind === 'reduction') {
      effectiveAt = subscription.periodEnd || new Date(Date.now() + 30 * 86400000);
      await tx.query(
        `update organization_rooftops set requested_extra_seats=$3,
           capacity_change_effective_at=$4,updated_at=now()
          where organization_id=$1 and dealership_id=$2`,
        [organizationId, dealershipId, requested, effectiveAt]
      );
    } else {
      // Setting the request back to effective capacity cancels a pending reduction.
      await tx.query(
        `update organization_rooftops set requested_extra_seats=null,
           capacity_change_effective_at=null,updated_at=now()
          where organization_id=$1 and dealership_id=$2`,
        [organizationId, dealershipId]
      );
    }
    await recordOrganizationAudit({
      organizationId,
      dealershipId,
      actorUserId: userId,
      action: increasing
        ? (increaseConfirmed ? 'capacity.increased' : 'capacity.increase_requested')
        : (kind === 'reduction' ? 'capacity.reduction_scheduled' : 'capacity.reduction_canceled'),
      targetType: 'organization_rooftop',
      targetId: `${organizationId}:${dealershipId}`,
      data: {
        previousExtraSeats: effectiveExtra,
        requestedExtraSeats: requested,
        organizationExtraSeatQuantity: targetTotal,
        effectiveAt
      }
    }, tx);
    return {
      changed: true,
      effectiveExtra: increasing ? requested : effectiveExtra,
      requestedExtra: requested,
      effectiveAt,
      organizationExtraSeatQuantity: targetTotal,
      increased: increasing,
      pending: increasing && !increaseConfirmed
    };
  }, { db, isolation: 'serializable', retries: 2 });

  if (result.increased && !result.pending) {
    await activateWaitingRequests(organizationId, dealershipId, db);
  }
  return result;
}

// Stripe applies a `pending_if_incomplete` seat increase only after the prorated invoice is
// paid. Until this reconciliation sees the new aggregate quantity, requested seats remain
// pending and cannot unlock List/Fill. The webhook path calls this; recovery sync can call it
// again safely.
export async function reconcilePendingCapacity(
  organizationId,
  stripeSubscription,
  db = pool,
  { extraSeatPriceId = process.env.STRIPE_EXTRA_SEAT_PRICE_ID } = {}
) {
  if (!extraSeatPriceId || !stripeSubscription || stripeSubscription.pending_update) {
    return { applied: 0 };
  }
  const item = findExtraSeatItem(stripeSubscription, null, extraSeatPriceId);
  const stripeQuantity = item ? Number(item.quantity || 0) : 0;
  const appliedDealerships = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `select dealership_id,extra_seats,requested_extra_seats
         from organization_rooftops
        where organization_id=$1 and requested_extra_seats > extra_seats
        order by dealership_id for update`,
      [organizationId]
    );
    if (!rows.length) return [];
    const { rows: totals } = await tx.query(
      `select coalesce(sum(extra_seats),0)::int as effective_total
         from organization_rooftops
        where organization_id=$1 and status in ('active','past_due','pending_removal')`,
      [organizationId]
    );
    const targetTotal = Number(totals[0].effective_total)
      + rows.reduce((sum, row) => sum + Number(row.requested_extra_seats) - Number(row.extra_seats), 0);
    if (stripeQuantity < targetTotal) return [];
    for (const row of rows) {
      await tx.query(
        `update organization_rooftops set extra_seats=requested_extra_seats,
           requested_extra_seats=null,capacity_change_effective_at=null,updated_at=now()
          where organization_id=$1 and dealership_id=$2`,
        [organizationId, row.dealership_id]
      );
      await recordOrganizationAudit({
        organizationId,
        dealershipId: row.dealership_id,
        actorUserId: 'stripe:webhook',
        action: 'capacity.increase_confirmed',
        targetType: 'organization_rooftop',
        targetId: `${organizationId}:${row.dealership_id}`,
        data: { extraSeats: row.requested_extra_seats, stripeQuantity }
      }, tx);
    }
    await tx.query(
      `update organization_billing_items set extra_seat_item_id=$2,
         extra_seat_quantity=$3,synced_at=now(),updated_at=now()
        where organization_id=$1`,
      [organizationId, item && item.id, stripeQuantity]
    );
    return rows.map((row) => row.dealership_id);
  }, { db, isolation: 'serializable', retries: 2 });
  for (const dealershipId of appliedDealerships) {
    await activateWaitingRequests(organizationId, dealershipId, db);
  }
  return { applied: appliedDealerships.length };
}

export async function applyScheduledCapacityReductions(db = pool, options = {}) {
  const stripeClient = options.stripeClient === undefined ? stripe : options.stripeClient;
  const extraSeatPriceId = options.extraSeatPriceId || process.env.STRIPE_EXTRA_SEAT_PRICE_ID;
  if (!stripeClient || !extraSeatPriceId) return { applied: 0, errors: [], skipped: 'billing_unavailable' };
  const { rows: organizations } = await db.query(
    `select distinct organization_id from organization_rooftops
      where requested_extra_seats is not null and capacity_change_effective_at <= now()`
  );
  const result = { applied: 0, errors: [] };
  for (const organization of organizations) {
    try {
      const applied = await withTransaction(async (tx) => {
        const organizationId = organization.organization_id;
        const { rows: subscriptionRows } = await tx.query(
          `select * from "subscription"
            where "referenceId"=$1 and plan='dealership_rooftop'
              and status in ('active','trialing','past_due')
            order by ("periodEnd" is null or "periodEnd">now()) desc,"periodEnd" desc nulls first
            limit 1 for update`,
          [organizationId]
        );
        const subscription = subscriptionRows[0];
        if (!subscription || !subscription.stripeSubscriptionId) {
          throw capacityError('active organization subscription not found', 409, 'no_subscription');
        }
        const { rows: rooftops } = await tx.query(
          `select * from organization_rooftops
            where organization_id=$1 and status in ('active','past_due','pending_removal')
            order by dealership_id for update`,
          [organizationId]
        );
        const due = rooftops.filter((row) => row.requested_extra_seats != null
          && row.capacity_change_effective_at
          && new Date(row.capacity_change_effective_at).getTime() <= Date.now());
        if (!due.length) return 0;
        const targetTotal = rooftops.reduce((sum, row) => sum + Number(
          due.includes(row) ? row.requested_extra_seats : row.extra_seats
        ), 0);
        const { rows: billingRows } = await tx.query(
          `select * from organization_billing_items where organization_id=$1 for update`,
          [organizationId]
        );
        const billing = billingRows[0] || {};
        const stripeSubscription = await stripeClient.subscriptions.retrieve(
          subscription.stripeSubscriptionId
        );
        const extraItem = findExtraSeatItem(
          stripeSubscription,
          billing.extra_seat_item_id,
          extraSeatPriceId
        );
        const key = idempotencyKey([
          organizationId,
          subscription.stripeSubscriptionId,
          targetTotal,
          ...due.map((row) => `${row.dealership_id}:${row.capacity_change_effective_at}`)
        ]);
        const extraItemId = await writeStripeQuantity({
          stripeClient,
          subscriptionId: subscription.stripeSubscriptionId,
          item: extraItem,
          priceId: extraSeatPriceId,
          quantity: targetTotal,
          prorationBehavior: 'none',
          key
        });
        for (const row of due) {
          await tx.query(
            `update organization_rooftops set
               extra_seats=requested_extra_seats,requested_extra_seats=null,
               capacity_change_effective_at=null,updated_at=now()
              where organization_id=$1 and dealership_id=$2`,
            [organizationId, row.dealership_id]
          );
          await recordOrganizationAudit({
            organizationId,
            dealershipId: row.dealership_id,
            actorUserId: 'system:capacity',
            action: 'capacity.reduction_applied',
            targetType: 'organization_rooftop',
            targetId: `${organizationId}:${row.dealership_id}`,
            data: { extraSeats: row.requested_extra_seats }
          }, tx);
        }
        await tx.query(
          `insert into organization_billing_items (
             organization_id,stripe_subscription_id,extra_seat_item_id,extra_seat_quantity,synced_at
           ) values ($1,$2,$3,$4,now())
           on conflict (organization_id) do update set
             stripe_subscription_id=excluded.stripe_subscription_id,
             extra_seat_item_id=excluded.extra_seat_item_id,
             extra_seat_quantity=excluded.extra_seat_quantity,
             synced_at=now(),updated_at=now()`,
          [organizationId, subscription.stripeSubscriptionId, extraItemId, targetTotal]
        );
        return due.length;
      }, { db, isolation: 'serializable', retries: 2 });
      result.applied += applied;
    } catch (err) {
      result.errors.push({ organizationId: organization.organization_id, error: err.message });
    }
  }
  return result;
}
