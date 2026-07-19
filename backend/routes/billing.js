import { Router } from 'express';
import crypto from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, billingConfigured } from '../auth.js';
import { requireUser } from '../mw.js';
import { pool } from '../db.js';
import { getUserDealership } from '../dealerships.js';
import { organizationsEnabled } from '../features.js';
import { getMembership } from '../organization-authz.js';
import {
  organizationCheckoutTarget,
  syncOrganizationSubscription
} from '../billing-lifecycle.js';
import {
  stripe,
  stripeConfigured,
  organizationStripeConfigured
} from '../stripe.js';
import { markClaimCheckoutPending } from '../claims.js';
import { changeRooftopCapacity } from '../capacity-billing.js';
import {
  hasLiveOrganizationSubscription,
  increaseOrganizationRooftops,
  scheduleOrganizationRooftopRemoval,
  cancelOrganizationRooftopRemoval
} from '../rooftop-billing.js';

const router = Router();
const PERSONAL_PRICE_ID = process.env.STRIPE_PRICE_ID || null;
const DEALERSHIP_PRICE_ID = process.env.STRIPE_DEALERSHIP_PRICE_ID || null;
const EXTRA_SEAT_PRICE_ID = process.env.STRIPE_EXTRA_SEAT_PRICE_ID || null;

const PLAN_COPY = {
  personal: {
    name: 'Carxpert Extension',
    amount: 8999,
    currency: 'usd',
    interval: 'month',
    includedSeats: 1,
    blurb: 'One-click dealer inventory to Facebook Marketplace, AI descriptions and translations, and cross-device sold and stats tracking.'
  },
  dealership: {
    name: 'Carxpert Dealership',
    amount: 49900,
    currency: 'usd',
    interval: 'month',
    includedSeats: 10,
    unit: 'rooftop',
    blurb: 'Team listing, rooftop-scoped seats, dealership reporting, and centralized billing.'
  },
  extraSeat: {
    name: 'Additional rooftop listing seat',
    amount: 0,
    currency: 'usd',
    interval: 'month',
    available: false
  }
};

function baseUrl(req) {
  return process.env.BETTER_AUTH_URL || `${req.protocol}://${req.get('host')}`;
}

function ensureStripe(res, target = 'personal') {
  const ready = target === 'organization' ? organizationStripeConfigured() : stripeConfigured();
  if (!ready || !billingConfigured()) {
    res.status(503).json({ ok: false, error: 'billing not configured', reason: 'billing_unavailable' });
    return false;
  }
  return true;
}

let planCache = null;
let planCacheUntil = 0;
async function publicPlans() {
  if (!stripe) return { ...PLAN_COPY, source: 'configured' };
  if (planCache && planCacheUntil > Date.now()) return planCache;
  const entries = await Promise.all([
    PERSONAL_PRICE_ID ? stripe.prices.retrieve(PERSONAL_PRICE_ID) : null,
    DEALERSHIP_PRICE_ID ? stripe.prices.retrieve(DEALERSHIP_PRICE_ID) : null,
    EXTRA_SEAT_PRICE_ID ? stripe.prices.retrieve(EXTRA_SEAT_PRICE_ID) : null
  ]);
  const format = (fallback, price) => ({
    ...fallback,
    amount: price && price.unit_amount != null ? price.unit_amount : fallback.amount,
    currency: price ? price.currency : fallback.currency,
    interval: price && price.recurring ? price.recurring.interval : fallback.interval,
    available: Boolean(price && price.active)
  });
  planCache = {
    personal: format(PLAN_COPY.personal, entries[0]),
    dealership: format(PLAN_COPY.dealership, entries[1]),
    extraSeat: format(PLAN_COPY.extraSeat, entries[2]),
    source: 'stripe'
  };
  planCacheUntil = Date.now() + 5 * 60 * 1000;
  return planCache;
}

// Old clients read `plan`; V2 clients read `plans`. Both come from Stripe when configured.
router.get('/api/billing/plan', async (_req, res, next) => {
  try {
    const plans = await publicPlans();
    res.json({ ok: true, plan: plans.personal, plans });
  } catch (err) { next(err); }
});

async function requireOrganizationOwner(userId, organizationId, db = pool) {
  const member = await getMembership(userId, organizationId, db);
  if (!member || member.status !== 'active' || member.role !== 'owner') {
    const err = new Error('organization owner required');
    err.status = 403;
    err.reason = 'owner_required';
    throw err;
  }
  return member;
}

export async function resolveBillingTarget(user, body = {}, db = pool) {
  const requested = body.target || (body.organizationId ? 'organization' : 'personal');
  if (requested === 'organization') {
    if (!organizationsEnabled()) {
      const err = new Error('organization billing is not enabled');
      err.status = 404;
      err.reason = 'organizations_disabled';
      throw err;
    }
    const organizationId = String(body.organizationId || '').trim();
    if (!organizationId) {
      const err = new Error('organizationId is required');
      err.status = 400;
      err.reason = 'organization_required';
      throw err;
    }
    const target = await organizationCheckoutTarget(user.id, organizationId, db);
    return {
      type: 'organization',
      referenceId: organizationId,
      customerType: 'organization',
      plan: 'dealership_rooftop',
      quantity: target.rooftopCount,
      reservationExpiresAt: target.reservationExpiresAt
    };
  }

  if (requested !== 'personal') {
    const err = new Error('invalid billing target');
    err.status = 400;
    err.reason = 'invalid_billing_target';
    throw err;
  }
  const dealership = await getUserDealership(user.id, db);
  if (!dealership) {
    const err = new Error('link a supported dealership first');
    err.status = 409;
    err.reason = 'no_dealership';
    throw err;
  }
  return {
    type: 'personal',
    referenceId: user.id,
    customerType: 'user',
    plan: 'carxpert',
    quantity: 1,
    dealership
  };
}

router.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  try {
    const target = await resolveBillingTarget(req.user, req.body || {});
    if (!ensureStripe(res, target.type === 'organization' ? 'organization' : 'personal')) return;
    if (target.type === 'organization' && await hasLiveOrganizationSubscription(target.referenceId)) {
      const changed = await increaseOrganizationRooftops(
        req.user.id,
        target.referenceId,
        target.quantity
      );
      let url = changed.url || null;
      if (changed.pending && !url) {
        const portal = await auth.api.createBillingPortal({
          headers: fromNodeHeaders(req.headers),
          body: {
            referenceId: target.referenceId,
            customerType: 'organization',
            locale: 'en',
            returnUrl: `${baseUrl(req)}/billing/success`,
            disableRedirect: true
          }
        });
        url = portal.url;
      }
      res.json({
        ok: true,
        url,
        target: target.type,
        completed: changed.completed,
        pending: changed.pending,
        rooftopQuantity: changed.requestedQuantity
      });
      return;
    }
    const result = await auth.api.upgradeSubscription({
      headers: fromNodeHeaders(req.headers),
      body: {
        plan: target.plan,
        referenceId: target.referenceId,
        customerType: target.customerType,
        seats: target.quantity,
        locale: 'en',
        disableRedirect: true,
        scheduleAtPeriodEnd: false,
        successUrl: `${baseUrl(req)}/billing/success`,
        cancelUrl: `${baseUrl(req)}/billing/cancelled`,
        returnUrl: `${baseUrl(req)}/billing/success`,
        metadata: {
          app: 'carxpert-extension',
          billingTarget: target.type
        }
      }
    });
    if (target.type === 'organization' && result && result.url) {
      await markClaimCheckoutPending(target.referenceId);
    }
    res.json({ ok: true, url: result.url, target: target.type });
  } catch (err) { next(err); }
});

router.post('/api/billing/portal', requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = body.organizationId ? String(body.organizationId) : null;
    const target = organizationId ? 'organization' : 'personal';
    if (!ensureStripe(res, target)) return;
    if (organizationId) await requireOrganizationOwner(req.user.id, organizationId);
    const result = await auth.api.createBillingPortal({
      headers: fromNodeHeaders(req.headers),
      body: {
        referenceId: organizationId || req.user.id,
        customerType: organizationId ? 'organization' : 'user',
        locale: 'en',
        returnUrl: `${baseUrl(req)}/billing/success`,
        disableRedirect: true
      }
    });
    res.json({ ok: true, url: result.url, target });
  } catch (err) { next(err); }
});

router.post('/api/billing/capacity', requireUser, async (req, res, next) => {
  try {
    if (!organizationsEnabled()) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const body = req.body || {};
    const result = await changeRooftopCapacity(
      req.user.id,
      String(body.organizationId || ''),
      String(body.dealershipId || ''),
      body.extraSeats
    );
    res.json({ ok: true, capacity: result });
  } catch (err) { next(err); }
});

router.post('/api/billing/rooftop-removal', requireUser, async (req, res, next) => {
  try {
    if (!organizationsEnabled()) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    if (!ensureStripe(res, 'organization')) return;
    const body = req.body || {};
    const args = [
      req.user.id,
      String(body.organizationId || ''),
      String(body.dealershipId || '')
    ];
    const result = body.cancel
      ? await cancelOrganizationRooftopRemoval(...args)
      : await scheduleOrganizationRooftopRemoval(...args);
    res.json({ ok: true, removal: result });
  } catch (err) { next(err); }
});

const syncHits = new Map();
function syncLimited(key) {
  const now = Date.now();
  const rec = syncHits.get(key) || { count: 0, reset: now + 3_600_000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 3_600_000; }
  rec.count += 1;
  syncHits.set(key, rec);
  return rec.count > 5;
}

async function recoveryTarget(userId, body, db = pool) {
  const organizationId = body && body.organizationId ? String(body.organizationId) : null;
  if (!organizationId) {
    const { rows } = await db.query('select "stripeCustomerId" from "user" where id=$1', [userId]);
    return {
      type: 'personal',
      referenceId: userId,
      customerId: rows[0] && rows[0].stripeCustomerId,
      priceId: PERSONAL_PRICE_ID,
      plan: 'carxpert'
    };
  }
  await requireOrganizationOwner(userId, organizationId, db);
  const { rows } = await db.query('select "stripeCustomerId" from "organization" where id=$1', [organizationId]);
  return {
    type: 'organization',
    referenceId: organizationId,
    customerId: rows[0] && rows[0].stripeCustomerId,
    priceId: DEALERSHIP_PRICE_ID,
    plan: 'dealership_rooftop'
  };
}

router.post('/api/billing/sync', requireUser, async (req, res, next) => {
  try {
    const target = await recoveryTarget(req.user.id, req.body || {});
    if (!ensureStripe(res, target.type)) return;
    const rateKey = `${req.user.id}:${target.referenceId}`;
    if (syncLimited(rateKey)) {
      res.status(429).json({ ok: false, error: 'slow down - try again shortly' });
      return;
    }
    if (!target.customerId) { res.json({ ok: true, synced: 0 }); return; }
    const subscriptions = await stripe.subscriptions.list({ customer: target.customerId, status: 'all', limit: 20 });
    let synced = 0;
    for (const stripeSubscription of subscriptions.data) {
      const item = stripeSubscription.items.data.find((candidate) =>
        candidate.price && candidate.price.id === target.priceId
      );
      if (!item) continue;
      const subscription = await upsertSubscription(target, stripeSubscription, item);
      if (target.type === 'organization') {
        await syncOrganizationSubscription(subscription, {
          stripeSubscription,
          source: 'stripe:recovery'
        });
      }
      synced += 1;
    }
    res.json({ ok: true, synced, target: target.type });
  } catch (err) { next(err); }
});

async function upsertSubscription(target, stripeSubscription, item, db = pool) {
  const date = (timestamp) => (timestamp ? new Date(timestamp * 1000) : null);
  const fields = {
    status: stripeSubscription.status,
    periodStart: date(item.current_period_start ?? stripeSubscription.current_period_start),
    periodEnd: date(item.current_period_end ?? stripeSubscription.current_period_end),
    cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
    cancelAt: date(stripeSubscription.cancel_at),
    canceledAt: date(stripeSubscription.canceled_at),
    endedAt: date(stripeSubscription.ended_at),
    seats: item.quantity || 1,
    billingInterval: item.price && item.price.recurring ? item.price.recurring.interval : null
  };
  const { rows: existing } = await db.query(
    'select id from "subscription" where "stripeSubscriptionId"=$1',
    [stripeSubscription.id]
  );
  const id = existing[0] ? existing[0].id : crypto.randomUUID();
  if (existing.length) {
    await db.query(
      `update "subscription" set
         plan=$2,"referenceId"=$3,"stripeCustomerId"=$4,status=$5,
         "periodStart"=$6,"periodEnd"=$7,"cancelAtPeriodEnd"=$8,"cancelAt"=$9,
         "canceledAt"=$10,"endedAt"=$11,seats=$12,"billingInterval"=$13
       where id=$1`,
      [
        id, target.plan, target.referenceId, target.customerId, fields.status,
        fields.periodStart, fields.periodEnd, fields.cancelAtPeriodEnd, fields.cancelAt,
        fields.canceledAt, fields.endedAt, fields.seats, fields.billingInterval
      ]
    );
  } else {
    await db.query(
      `insert into "subscription" (
         id,plan,"referenceId","stripeCustomerId","stripeSubscriptionId",status,
         "periodStart","periodEnd","cancelAtPeriodEnd","cancelAt","canceledAt","endedAt",seats,"billingInterval"
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id, target.plan, target.referenceId, target.customerId, stripeSubscription.id,
        fields.status, fields.periodStart, fields.periodEnd, fields.cancelAtPeriodEnd,
        fields.cancelAt, fields.canceledAt, fields.endedAt, fields.seats, fields.billingInterval
      ]
    );
  }
  return {
    id,
    plan: target.plan,
    referenceId: target.referenceId,
    stripeCustomerId: target.customerId,
    stripeSubscriptionId: stripeSubscription.id,
    ...fields
  };
}

function page(title, msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><body style="font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f8fa;color:#1f2328">
<div style="text-align:center;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p>${msg}</p>
<p style="color:#57606a">You can close this tab and return to the Carxpert extension.</p></div>`;
}
router.get('/billing/success', (_req, res) => res.type('html').send(page('Subscription active', 'Your Carxpert subscription is set up.')));
router.get('/billing/cancelled', (_req, res) => res.type('html').send(page('Checkout cancelled', 'No charge was made.')));

export default router;
