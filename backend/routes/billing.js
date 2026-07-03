import { Router } from 'express';
import crypto from 'node:crypto';
import { requireUser } from '../mw.js';
import { pool } from '../db.js';
import { getUserDealership } from '../dealerships.js';
import { stripe, stripeConfigured } from '../stripe.js';

const router = Router();
const PRICE_ID = process.env.STRIPE_PRICE_ID || null;

// Price + copy live here (backend config), so changing the price never needs an extension
// release — the side panel renders whatever /api/billing/plan returns.
const PLAN = {
  name: 'Carxpert Extension',
  amount: 8999,
  currency: 'usd',
  interval: 'month',
  blurb: 'One-click dealer inventory to Facebook Marketplace, AI descriptions & translations, and cross-device sold/stats tracking.'
};

function baseUrl(req) {
  return process.env.BETTER_AUTH_URL || `${req.protocol}://${req.get('host')}`;
}
function ensureStripe(res) {
  if (!stripeConfigured()) { res.status(503).json({ ok: false, error: 'billing not configured' }); return false; }
  return true;
}

// --- public: price + value copy ---
router.get('/api/billing/plan', (_req, res) => res.json({ ok: true, plan: PLAN }));

async function getOrCreateCustomer(user) {
  const { rows } = await pool.query('select "stripeCustomerId" from "user" where id = $1', [user.id]);
  if (rows[0] && rows[0].stripeCustomerId) return rows[0].stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email, name: user.name, metadata: { app: 'carxpert-extension', userId: user.id }
  });
  await pool.query('update "user" set "stripeCustomerId" = $1 where id = $2', [customer.id, user.id]);
  return customer.id;
}

// --- checkout: bearer + linked dealership (gate order: sign in → link → subscribe) ---
router.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  try {
    if (!ensureStripe(res)) return;
    const dealership = await getUserDealership(req.user.id);
    if (!dealership) {
      res.status(409).json({ ok: false, error: 'link a supported dealership first', reason: 'no_dealership' });
      return;
    }
    const customer = await getOrCreateCustomer(req.user);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      // A 100%-off promo yields a $0 subscription; 'if_required' skips card collection so
      // friends can test on prod without a card.
      payment_method_collection: 'if_required',
      client_reference_id: req.user.id,
      subscription_data: { metadata: { app: 'carxpert-extension', userId: req.user.id } },
      success_url: `${baseUrl(req)}/billing/success`,
      cancel_url: `${baseUrl(req)}/billing/cancelled`
    });
    res.json({ ok: true, url: session.url });
  } catch (err) { next(err); }
});

// --- portal: bearer; Stripe-hosted manage/cancel ---
router.post('/api/billing/portal', requireUser, async (req, res, next) => {
  try {
    if (!ensureStripe(res)) return;
    const { rows } = await pool.query('select "stripeCustomerId" from "user" where id = $1', [req.user.id]);
    const customer = rows[0] && rows[0].stripeCustomerId;
    if (!customer) { res.status(409).json({ ok: false, error: 'no billing account yet' }); return; }
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${baseUrl(req)}/billing/success` });
    res.json({ ok: true, url: session.url });
  } catch (err) { next(err); }
});

// --- sync: bearer, rate-limited; recovery when a webhook is delayed and the user is staring
//     at a "not active yet" gate right after paying ---
const syncHits = new Map();
function syncLimited(userId) {
  const now = Date.now();
  const rec = syncHits.get(userId) || { count: 0, reset: now + 3_600_000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 3_600_000; }
  rec.count += 1; syncHits.set(userId, rec);
  return rec.count > 5;
}
router.post('/api/billing/sync', requireUser, async (req, res, next) => {
  try {
    if (!ensureStripe(res)) return;
    if (syncLimited(req.user.id)) { res.status(429).json({ ok: false, error: 'slow down — try again shortly' }); return; }
    const { rows } = await pool.query('select "stripeCustomerId" from "user" where id = $1', [req.user.id]);
    const customer = rows[0] && rows[0].stripeCustomerId;
    if (!customer) { res.json({ ok: true, synced: 0 }); return; }
    const subs = await stripe.subscriptions.list({ customer, status: 'all', limit: 10 });
    let synced = 0;
    for (const s of subs.data) {
      const item = s.items.data.find((i) => i.price && i.price.id === PRICE_ID);
      if (!item) continue;
      await upsertSubscription(req.user.id, customer, s, item);
      synced += 1;
    }
    res.json({ ok: true, synced });
  } catch (err) { next(err); }
});

// Keyed on stripeSubscriptionId so it converges with the plugin's webhook row (which also
// looks up by that field) — no duplicate rows whether the webhook or this sync lands first.
async function upsertSubscription(userId, customer, s, item) {
  const d = (t) => (t ? new Date(t * 1000) : null);
  const f = {
    status: s.status,
    periodStart: d(item.current_period_start ?? s.current_period_start),
    periodEnd: d(item.current_period_end ?? s.current_period_end),
    cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
    cancelAt: d(s.cancel_at),
    canceledAt: d(s.canceled_at),
    endedAt: d(s.ended_at),
    seats: item.quantity || 1,
    billingInterval: item.price && item.price.recurring ? item.price.recurring.interval : null
  };
  const existing = await pool.query('select id from "subscription" where "stripeSubscriptionId" = $1', [s.id]);
  if (existing.rows.length) {
    await pool.query(
      `update "subscription" set
         "status"=$2,"periodStart"=$3,"periodEnd"=$4,"cancelAtPeriodEnd"=$5,"cancelAt"=$6,
         "canceledAt"=$7,"endedAt"=$8,"seats"=$9,"billingInterval"=$10
       where id=$1`,
      [existing.rows[0].id, f.status, f.periodStart, f.periodEnd, f.cancelAtPeriodEnd,
       f.cancelAt, f.canceledAt, f.endedAt, f.seats, f.billingInterval]
    );
  } else {
    await pool.query(
      `insert into "subscription"
         ("id","plan","referenceId","stripeCustomerId","stripeSubscriptionId","status",
          "periodStart","periodEnd","cancelAtPeriodEnd","cancelAt","canceledAt","endedAt","seats","billingInterval")
       values ($1,'carxpert',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [crypto.randomUUID(), userId, customer, s.id, f.status, f.periodStart, f.periodEnd,
       f.cancelAtPeriodEnd, f.cancelAt, f.canceledAt, f.endedAt, f.seats, f.billingInterval]
    );
  }
}

// --- tiny hosted return pages (Checkout success/cancel URLs must not be chrome-extension URLs) ---
function page(title, msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><body style="font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f8fa;color:#1f2328">
<div style="text-align:center;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p>${msg}</p>
<p style="color:#57606a">You can close this tab and return to the Carxpert extension.</p></div>`;
}
router.get('/billing/success', (_req, res) => res.type('html').send(page('Subscription active 🎉', 'Your Carxpert subscription is set up.')));
router.get('/billing/cancelled', (_req, res) => res.type('html').send(page('Checkout cancelled', 'No charge was made.')));

export default router;
