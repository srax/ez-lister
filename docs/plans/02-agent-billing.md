# Agent brief — Billing & Entitlement (Stripe, Better Auth stripe plugin, lease signing)

Read `00-architecture-contract.md` first. You own `routes/billing.js`,
`webhooks/stripe.js`, and `entitlement/` (including lease signing + JWKS). You start once
the core agent's A1 lands (Better Auth instance + bearer auth + `/api/me` shell + your
stubbed `entitlement/` module). Replace the stub's internals; do not change its exported
API — `/api/me` and the AI/listings gates already call it.

Product rules you are implementing:
- Stripe is the billing source of truth. No free tier.
- Entitled subscription statuses: `active`, `trialing` — nothing else. No `past_due`
  grace. Cancel-at-period-end keeps access until `current_period_end`.
- Entitlement = signed in AND (active/trialing subscription OR valid comp grant) AND
  linked supported dealership.
- Friend testing: 100%-off promotion code, no card —
  `payment_method_collection: 'if_required'` on Checkout.

## B1 — Stripe wiring

**Plugin:** add `@better-auth/stripe` to the Better Auth instance in `auth.js` (small,
additive edit — coordinate with the core agent to avoid conflicts). Let it own the
`subscription` table (generate + commit its migration via the Better Auth CLI) and the
customer⇄user linkage. Before building on it, verify the plugin's checkout wrapper lets
you pass `allow_promotion_codes: true` and `payment_method_collection: 'if_required'`
(via its checkout-params hook); if it fights you, keep the plugin for customer/webhook/
subscription bookkeeping and create the Checkout Session directly with the `stripe` SDK —
don't contort the flow to fit the plugin.

**Routes:**
- `GET /api/billing/plan` (public): price, currency, interval, value copy — all from
  backend config/env (`STRIPE_PRICE_ID` + copy constants), so price changes never require
  an extension release.
- `POST /api/billing/checkout` (bearer): reject with a typed error if the user has no
  linked supported dealership (`user_dealerships` — that's the product gate order:
  sign in → link → subscribe). Create Checkout Session: the configured price, promotion
  codes on, `payment_method_collection: 'if_required'`, `client_reference_id = userId`,
  success/cancel URLs pointing at tiny backend-hosted pages (`/billing/success`,
  `/billing/cancelled` — static HTML, "you can close this tab and return to the
  extension"), never chrome-extension URLs. Return `{ url }`.
- `POST /api/billing/portal` (bearer): Billing Portal session for the user's customer,
  return `{ url }`.
- `POST /api/billing/sync` (bearer, rate-limited ~5/hour/user): fetch the user's
  subscriptions from Stripe and reconcile the local `subscription` row. This is the
  recovery path when a webhook is delayed and the user is staring at a "not active yet"
  gate right after paying.

**Webhook (`POST /api/webhooks/stripe`):**
- Mounted with `express.raw({ type: 'application/json' })` BEFORE any json body parser —
  signature verification (`stripe.webhooks.constructEvent`) needs the raw bytes. This is
  the classic integration failure; get it right first.
- Handle `checkout.session.completed`, `customer.subscription.created/updated/deleted`,
  `invoice.paid`, `invoice.payment_failed` → upsert subscription state. Idempotent by
  design (state upserts keyed on subscription id, not event-count logic). Return 2xx fast;
  do work inline (it's cheap) but never let a handler error turn into endless Stripe retries
  of a poison event — catch, log, 200 on non-retryable failures.

## B2 — Entitlement module + lease

`entitlement/index.js`:

```js
export async function isEntitled(userId) {
  // 1. comp_grants row with expires_at null-or-future → entitled (reason 'ok')
  // 2. else subscription row for user with status in ('active','trialing')
  //    AND period end in the future → entitled
  //    (cancel_at_period_end true is fine — status stays 'active' until Stripe flips it;
  //     the period-end check is the belt-and-braces for stale rows)
  // 3. AND user has a user_dealerships row → otherwise reason 'no_dealership'
  // → { entitled, reason: 'ok'|'no_subscription'|'expired'|'no_dealership', periodEnd }
}
```

`entitlement/keys.js` + lease signing:
- ES256 (P-256). Private key from `LEASE_PRIVATE_KEY_PEM` (PKCS8) + `LEASE_KID`; fail
  loudly at boot in production if missing. Document the one-liner to generate a keypair
  (`openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt`).
- Use `jose` for signing (it's the one dependency worth taking; hand-rolled JWS is how
  you get alg-confusion bugs). `issueLease(user, dealership)`:
  header `{ alg:'ES256', kid }`, claims
  `{ sub, dlr, dom: dealership.domains, ent: true, iat, exp: iat + 90*60 }`.
- `GET /.well-known/jwks.json`: public JWK(s) with kid. Support serving two kids during
  rotation (env accepts an optional previous public key).
- Write a node:test that signs a lease and verifies it with **pure WebCrypto**
  (`crypto.subtle.importKey(jwk) + verify('ECDSA', {hash:'SHA-256'})`) — that proves the
  MV3 service worker can verify it without a library, which is the whole reason for ES256.

`/api/me` integration: entitled → include a fresh lease on every call; not entitled →
`lease: null` plus `{ entitled: false, reason }` so the extension can render the right
gate step (sign in → link dealership → subscribe → ready).

`comp_grants` admin: `POST /api/admin/comp` (ADMIN_TOKEN) — grant/revoke by email, with
optional expiry and note. This is how friends test without touching Stripe at all, and
the fallback if the 100%-off promo path has friction.

## Testing / verification

- Stripe test mode end-to-end with the Stripe CLI (`stripe listen --forward-to`):
  checkout with a 100%-off promo (no card collected) → webhook → `isEntitled` true →
  `/api/me` returns a verifiable lease; cancel at period end → still entitled; delete
  subscription → gate closes; `billing/sync` reconciles with webhooks disabled.
- Unit tests: entitlement decision matrix (each status × period-end × comp × dealership),
  lease claims/expiry, JWKS shape.
- Never log full Stripe objects (they contain PII); log ids + status transitions.

## Explicitly not yours

Dealership linking (core agent), AI daily limits (core agent consumes your `isEntitled`),
all extension-side lease verification/gate UX (third workstream — the contract doc
specifies the lease format they verify against).
