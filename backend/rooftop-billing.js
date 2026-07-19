import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { stripe } from './stripe.js';
import { requireMembership, requireOwner } from './organization-authz.js';
import { markClaimCheckoutPending } from './claims.js';
import { createOrganizationNotification, recordOrganizationAudit } from './organization-audit.js';
import { syncOrganizationSubscription } from './billing-lifecycle.js';

function billingError(message, status = 400, reason = 'invalid_billing_change') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function idempotencyKey(parts) {
  return `carxpert-rooftops-${crypto.createHash('sha256')
    .update(parts.join(':')).digest('hex').slice(0, 32)}`;
}

function findRooftopItem(subscription, itemId, priceId) {
  const items = subscription && subscription.items ? subscription.items.data || [] : [];
  return items.find((item) => item.id === itemId)
    || items.find((item) => item.price && item.price.id === priceId)
    || null;
}

export function stripeActionUrl(subscription) {
  const invoice = subscription && typeof subscription.latest_invoice === 'object'
    ? subscription.latest_invoice
    : null;
  if (!invoice) return null;
  const paymentIntent = invoice.payment_intent && typeof invoice.payment_intent === 'object'
    ? invoice.payment_intent
    : null;
  const redirect = paymentIntent && paymentIntent.next_action
    && paymentIntent.next_action.redirect_to_url;
  return (redirect && redirect.url) || invoice.hosted_invoice_url || null;
}

async function activeSubscription(organizationId, db) {
  const { rows } = await db.query(
    `select * from "subscription"
      where "referenceId"=$1 and plan='dealership_rooftop'
        and status in ('active','trialing')
      order by ("periodEnd" is null or "periodEnd">now()) desc,"periodEnd" desc nulls first
      limit 1`,
    [organizationId]
  );
  return rows[0] || null;
}

export async function hasLiveOrganizationSubscription(organizationId, db = pool) {
  return Boolean(await activeSubscription(organizationId, db));
}

// Better Auth owns initial Checkout and webhook persistence. This adapter covers the one
// operation its generic upgrade endpoint cannot make fail-closed for us: increasing the
// quantity of an existing rooftop subscription without granting access before an invoice is
// paid. Claims remain reserved until a Stripe payload confirms the new quantity.
export async function increaseOrganizationRooftops(
  userId,
  organizationId,
  requestedQuantity,
  db = pool,
  options = {}
) {
  const stripeClient = options.stripeClient === undefined ? stripe : options.stripeClient;
  const rooftopPriceId = options.rooftopPriceId || process.env.STRIPE_DEALERSHIP_PRICE_ID;
  if (!stripeClient || !rooftopPriceId) {
    throw billingError('organization billing is not configured', 503, 'billing_unavailable');
  }
  const requested = Number(requestedQuantity);
  if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
    throw billingError('rooftop quantity must be an integer between 1 and 500');
  }

  const member = await requireMembership(userId, organizationId, db);
  requireOwner(member);
  const subscription = await activeSubscription(organizationId, db);
  if (!subscription || !subscription.stripeSubscriptionId) {
    throw billingError('active organization subscription not found', 409, 'no_subscription');
  }
  const { rows: billingRows } = await db.query(
    'select * from organization_billing_items where organization_id=$1',
    [organizationId]
  );
  const billing = billingRows[0] || {};
  const { rows: claimRows } = await db.query(
    `select id,status,updated_at from dealership_claims
      where organization_id=$1
        and (status='active' or (
          status in ('approved','checkout_pending') and reservation_expires_at > now()
        ))
      order by created_at,id`,
    [organizationId]
  );
  if (requested > claimRows.length) {
    throw billingError('approved rooftop claims do not match the requested quantity', 409, 'claim_approval_required');
  }

  const currentStripeSubscription = await stripeClient.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
    { expand: ['latest_invoice.payment_intent'] }
  );
  const rooftopItem = findRooftopItem(
    currentStripeSubscription,
    billing.rooftop_item_id,
    rooftopPriceId
  );
  if (!rooftopItem) {
    throw billingError('rooftop subscription item not found', 409, 'subscription_item_missing');
  }
  const currentQuantity = Math.max(0, Number(rooftopItem.quantity || 0));
  if (requested < currentQuantity) {
    throw billingError(
      'rooftop reductions must use the scheduled removal workflow',
      409,
      'rooftop_reduction_requires_schedule'
    );
  }
  if (currentStripeSubscription.pending_update) {
    return {
      changed: false,
      pending: true,
      currentQuantity,
      requestedQuantity: requested,
      url: stripeActionUrl(currentStripeSubscription)
    };
  }
  if (requested === currentQuantity) {
    const synced = await syncOrganizationSubscription({
      ...subscription,
      referenceId: organizationId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      seats: currentQuantity
    }, {
      stripeSubscription: currentStripeSubscription,
      source: 'stripe:rooftop-recovery',
      db
    });
    return {
      changed: false,
      pending: false,
      completed: true,
      currentQuantity,
      requestedQuantity: requested,
      activated: synced.organization
    };
  }

  const key = idempotencyKey([
    organizationId,
    subscription.stripeSubscriptionId,
    rooftopItem.id,
    currentQuantity,
    requested,
    ...claimRows.map((claim) => `${claim.id}:${new Date(claim.updated_at).toISOString()}`)
  ]);
  await stripeClient.subscriptionItems.update(rooftopItem.id, {
    quantity: requested,
    proration_behavior: 'always_invoice',
    payment_behavior: 'pending_if_incomplete'
  }, { idempotencyKey: key });
  await markClaimCheckoutPending(organizationId, db);

  const confirmedSubscription = await stripeClient.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
    { expand: ['latest_invoice.payment_intent'] }
  );
  const confirmedItem = findRooftopItem(confirmedSubscription, rooftopItem.id, rooftopPriceId);
  const confirmedQuantity = confirmedItem ? Math.max(0, Number(confirmedItem.quantity || 0)) : 0;
  const completed = confirmedQuantity >= requested && !confirmedSubscription.pending_update;
  if (completed) {
    await db.query('update "subscription" set seats=$2 where id=$1', [
      subscription.id,
      confirmedQuantity
    ]);
    await syncOrganizationSubscription({
      ...subscription,
      referenceId: organizationId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      seats: confirmedQuantity
    }, {
      stripeSubscription: confirmedSubscription,
      source: 'stripe:rooftop-change',
      db
    });
  }
  await recordOrganizationAudit({
    organizationId,
    actorUserId: userId,
    action: completed ? 'billing.rooftop_quantity_increased' : 'billing.rooftop_quantity_requested',
    targetType: 'subscription',
    targetId: subscription.stripeSubscriptionId,
    data: { previousQuantity: currentQuantity, requestedQuantity: requested, confirmedQuantity }
  }, db);
  return {
    changed: true,
    pending: !completed,
    completed,
    currentQuantity,
    requestedQuantity: requested,
    confirmedQuantity,
    url: completed ? null : stripeActionUrl(confirmedSubscription)
  };
}

export async function scheduleOrganizationRooftopRemoval(
  userId,
  organizationId,
  dealershipId,
  db = pool,
  options = {}
) {
  const stripeClient = options.stripeClient === undefined ? stripe : options.stripeClient;
  const rooftopPriceId = options.rooftopPriceId || process.env.STRIPE_DEALERSHIP_PRICE_ID;
  if (!stripeClient || !rooftopPriceId) {
    throw billingError('organization billing is not configured', 503, 'billing_unavailable');
  }
  return withTransaction(async (tx) => {
    const member = await requireMembership(userId, organizationId, tx);
    requireOwner(member);
    await tx.query('select id from "organization" where id=$1 for update', [organizationId]);
    const { rows: rooftopRows } = await tx.query(
      `select * from organization_rooftops
        where organization_id=$1 and dealership_id=$2 for update`,
      [organizationId, dealershipId]
    );
    const rooftop = rooftopRows[0];
    if (!rooftop || !['active', 'past_due'].includes(rooftop.status)) {
      throw billingError('active rooftop not found', 404, 'wrong_rooftop');
    }
    const { rows: remainingRows } = await tx.query(
      `select count(*)::int as count from organization_rooftops
        where organization_id=$1 and dealership_id<>$2
          and status in ('active','past_due','pending_removal')`,
      [organizationId, dealershipId]
    );
    if (remainingRows[0].count < 1) {
      throw billingError(
        'use the billing portal to cancel the final rooftop and organization subscription',
        409,
        'final_rooftop_requires_cancellation'
      );
    }
    const subscription = await activeSubscription(organizationId, tx);
    if (!subscription || !subscription.stripeSubscriptionId) {
      throw billingError('active organization subscription not found', 409, 'no_subscription');
    }
    const effectiveAt = subscription.periodEnd && new Date(subscription.periodEnd);
    if (!effectiveAt || !Number.isFinite(effectiveAt.getTime()) || effectiveAt.getTime() <= Date.now()) {
      throw billingError('subscription renewal date is unavailable', 409, 'renewal_date_unavailable');
    }
    const { rows: billingRows } = await tx.query(
      'select * from organization_billing_items where organization_id=$1 for update',
      [organizationId]
    );
    const billing = billingRows[0] || {};
    const current = await stripeClient.subscriptions.retrieve(subscription.stripeSubscriptionId);
    if (current.pending_update) {
      throw billingError('another billing change is awaiting payment', 409, 'billing_change_pending');
    }
    const item = findRooftopItem(current, billing.rooftop_item_id, rooftopPriceId);
    if (!item || Number(item.quantity || 0) < 2) {
      throw billingError('paid rooftop quantity cannot be reduced', 409, 'invalid_rooftop_quantity');
    }
    const currentQuantity = Number(item.quantity);
    const requestedQuantity = currentQuantity - 1;
    await tx.query(
      `update organization_rooftops set status='pending_removal',removal_effective_at=$3,
         updated_at=now() where organization_id=$1 and dealership_id=$2`,
      [organizationId, dealershipId, effectiveAt]
    );
    const key = idempotencyKey([
      'remove', organizationId, dealershipId, subscription.stripeSubscriptionId,
      currentQuantity, requestedQuantity, effectiveAt.toISOString()
    ]);
    const updatedItem = await stripeClient.subscriptionItems.update(item.id, {
      quantity: requestedQuantity,
      proration_behavior: 'none'
    }, { idempotencyKey: key });
    if (!updatedItem || Number(updatedItem.quantity || 0) !== requestedQuantity) {
      throw billingError('Stripe did not confirm the scheduled rooftop reduction', 409, 'stripe_confirmation_pending');
    }
    await tx.query('update "subscription" set seats=$2 where id=$1', [
      subscription.id,
      requestedQuantity
    ]);
    await tx.query(
      `insert into organization_billing_items (
         organization_id,stripe_subscription_id,rooftop_item_id,rooftop_quantity,synced_at
       ) values ($1,$2,$3,$4,now())
       on conflict (organization_id) do update set
         stripe_subscription_id=excluded.stripe_subscription_id,
         rooftop_item_id=excluded.rooftop_item_id,
         rooftop_quantity=excluded.rooftop_quantity,
         synced_at=now(),updated_at=now()`,
      [organizationId, subscription.stripeSubscriptionId, item.id, requestedQuantity]
    );
    await recordOrganizationAudit({
      organizationId,
      dealershipId,
      actorUserId: userId,
      action: 'billing.rooftop_removal_scheduled',
      targetType: 'organization_rooftop',
      targetId: `${organizationId}:${dealershipId}`,
      data: { effectiveAt, previousQuantity: currentQuantity, requestedQuantity }
    }, tx);
    return { scheduled: true, effectiveAt, currentQuantity, requestedQuantity };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function cancelOrganizationRooftopRemoval(
  userId,
  organizationId,
  dealershipId,
  db = pool,
  options = {}
) {
  const stripeClient = options.stripeClient === undefined ? stripe : options.stripeClient;
  const rooftopPriceId = options.rooftopPriceId || process.env.STRIPE_DEALERSHIP_PRICE_ID;
  if (!stripeClient || !rooftopPriceId) {
    throw billingError('organization billing is not configured', 503, 'billing_unavailable');
  }
  return withTransaction(async (tx) => {
    const member = await requireMembership(userId, organizationId, tx);
    requireOwner(member);
    await tx.query('select id from "organization" where id=$1 for update', [organizationId]);
    const { rows: rooftopRows } = await tx.query(
      `select * from organization_rooftops
        where organization_id=$1 and dealership_id=$2 and status='pending_removal'
        for update`,
      [organizationId, dealershipId]
    );
    const rooftop = rooftopRows[0];
    if (!rooftop) throw billingError('scheduled rooftop removal not found', 404, 'removal_not_found');
    if (!rooftop.removal_effective_at || new Date(rooftop.removal_effective_at).getTime() <= Date.now()) {
      throw billingError('the rooftop removal is already effective', 409, 'removal_already_effective');
    }
    const subscription = await activeSubscription(organizationId, tx);
    if (!subscription || !subscription.stripeSubscriptionId) {
      throw billingError('active organization subscription not found', 409, 'no_subscription');
    }
    const { rows: billingRows } = await tx.query(
      'select * from organization_billing_items where organization_id=$1 for update',
      [organizationId]
    );
    const billing = billingRows[0] || {};
    const current = await stripeClient.subscriptions.retrieve(subscription.stripeSubscriptionId);
    if (current.pending_update) {
      throw billingError('another billing change is awaiting payment', 409, 'billing_change_pending');
    }
    const item = findRooftopItem(current, billing.rooftop_item_id, rooftopPriceId);
    if (!item) throw billingError('rooftop subscription item not found', 409, 'subscription_item_missing');
    const currentQuantity = Math.max(0, Number(item.quantity || 0));
    const requestedQuantity = currentQuantity + 1;
    await tx.query(
      `update organization_rooftops set status='active',removal_effective_at=null,updated_at=now()
        where organization_id=$1 and dealership_id=$2`,
      [organizationId, dealershipId]
    );
    const key = idempotencyKey([
      'restore', organizationId, dealershipId, subscription.stripeSubscriptionId,
      currentQuantity, requestedQuantity, new Date(rooftop.removal_effective_at).toISOString()
    ]);
    const updatedItem = await stripeClient.subscriptionItems.update(item.id, {
      quantity: requestedQuantity,
      proration_behavior: 'none'
    }, { idempotencyKey: key });
    if (!updatedItem || Number(updatedItem.quantity || 0) !== requestedQuantity) {
      throw billingError('Stripe did not confirm the rooftop restoration', 409, 'stripe_confirmation_pending');
    }
    await tx.query('update "subscription" set seats=$2 where id=$1', [
      subscription.id,
      requestedQuantity
    ]);
    await tx.query(
      `update organization_billing_items set rooftop_item_id=$2,rooftop_quantity=$3,
         synced_at=now(),updated_at=now() where organization_id=$1`,
      [organizationId, item.id, requestedQuantity]
    );
    await recordOrganizationAudit({
      organizationId,
      dealershipId,
      actorUserId: userId,
      action: 'billing.rooftop_removal_canceled',
      targetType: 'organization_rooftop',
      targetId: `${organizationId}:${dealershipId}`,
      data: { previousQuantity: currentQuantity, requestedQuantity }
    }, tx);
    return { canceled: true, currentQuantity, requestedQuantity };
  }, { db, isolation: 'serializable', retries: 2 });
}

export async function applyScheduledRooftopRemovals(db = pool, now = new Date()) {
  const { rows: dueRows } = await db.query(
    `select organization_id,dealership_id from organization_rooftops
      where status='pending_removal' and removal_effective_at <= $1
      order by removal_effective_at,organization_id,dealership_id`,
    [now]
  );
  let applied = 0;
  for (const due of dueRows) {
    const changed = await withTransaction(async (tx) => {
      await tx.query('select id from "organization" where id=$1 for update', [due.organization_id]);
      const { rows } = await tx.query(
        `select * from organization_rooftops
          where organization_id=$1 and dealership_id=$2 and status='pending_removal'
            and removal_effective_at <= $3 for update`,
        [due.organization_id, due.dealership_id, now]
      );
      if (!rows.length) return false;
      const affectedResult = await tx.query(
        `select distinct m."userId" as user_id
           from "member" m
           left join member_rooftop_access a on a.member_id=m.id and a.revoked_at is null
           left join seat_assignments s on s.member_id=m.id and s.released_at is null
          where m."organizationId"=$1
            and (a.dealership_id=$2 or s.dealership_id=$2)`,
        [due.organization_id, due.dealership_id]
      );
      const invitationResult = await tx.query(
        `update "invitation" set status='canceled'
          where status='pending' and "organizationId"=$1 and id in (
            select invitation_id from organization_invitation_rooftops where dealership_id=$2
          ) returning id`,
        [due.organization_id, due.dealership_id]
      );
      if (invitationResult.rows.length) {
        await tx.query(
          `update seat_reservations set released_at=now()
            where target_type='invitation' and target_id=any($1) and released_at is null`,
          [invitationResult.rows.map((row) => row.id)]
        );
      }
      await tx.query(
        `update seat_assignments set released_at=now(),released_by='system:rooftop-removal'
          where organization_id=$1 and dealership_id=$2 and released_at is null`,
        [due.organization_id, due.dealership_id]
      );
      await tx.query(
        `update seat_reservations set released_at=now()
          where organization_id=$1 and dealership_id=$2 and released_at is null`,
        [due.organization_id, due.dealership_id]
      );
      await tx.query(
        `update member_rooftop_access set revoked_at=now()
          where organization_id=$1 and dealership_id=$2 and revoked_at is null`,
        [due.organization_id, due.dealership_id]
      );
      await tx.query(
        `update organization_access_requests set status='canceled',updated_at=now()
          where organization_id=$1 and dealership_id=$2
            and status in ('pending','approved_awaiting_capacity')`,
        [due.organization_id, due.dealership_id]
      );
      await tx.query(
        `update organization_member_profiles mp set status='removed',removed_at=now(),updated_at=now()
          where mp.organization_id=$1 and mp.role<>'owner' and mp.all_rooftops=false
            and not exists (
              select 1 from member_rooftop_access a
               where a.member_id=mp.member_id and a.revoked_at is null
            )`,
        [due.organization_id]
      );
      await tx.query(
        `update dealership_claims set status='suspended',reviewed_by='system:rooftop-removal',
           reviewed_at=now(),review_reason='Removed from organization at subscription renewal',
           updated_at=now()
          where organization_id=$1 and dealership_id=$2 and status='active'`,
        [due.organization_id, due.dealership_id]
      );
      await tx.query(
        `update organization_rooftops set status='archived',archived_at=now(),
           removal_effective_at=null,updated_at=now()
          where organization_id=$1 and dealership_id=$2`,
        [due.organization_id, due.dealership_id]
      );
      await recordOrganizationAudit({
        organizationId: due.organization_id,
        dealershipId: due.dealership_id,
        actorUserId: 'system:rooftop-removal',
        action: 'billing.rooftop_removed',
        targetType: 'organization_rooftop',
        targetId: `${due.organization_id}:${due.dealership_id}`
      }, tx);
      for (const affected of affectedResult.rows) {
        await createOrganizationNotification({
          userId: affected.user_id,
          organizationId: due.organization_id,
          type: 'rooftop_removed',
          data: { dealershipId: due.dealership_id }
        }, tx);
      }
      return true;
    }, { db, isolation: 'serializable', retries: 2 });
    if (changed) applied += 1;
  }
  return { applied };
}
