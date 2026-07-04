# Billing Agent (B) — Ready-to-Start Context Pack

Prepared by the backend-core agent after A0–A5 landed. Read `00-architecture-contract.md`
and `02-agent-billing.md` first — this doc is the *current-state* layer on top of them: what
already exists, the exact seams to build into, live Stripe/Railway facts, and the commands
that remove setup friction. **You are unblocked to start now** (A1 merged long ago).

## 1. The entitlement seam — already stubbed, wired, and called

You replace the internals of `backend/entitlement/index.js`; **do not change its exported
API**. It is already imported in three places, so the moment your `isEntitled` returns
`{entitled:true}` for a real subscriber, gates open with no other edits:

| Consumer | File | Effect when you make isEntitled real |
|---|---|---|
| Profile + lease | `backend/routes/me.js` | `/api/me` should then attach a fresh lease (you add the `issueLease` call — the `void ent` placeholder + `lease` var are already there) |
| Listings read gate | `backend/entitlement/gate.js` → `routes/listings.js` | `GET /api/listings` flips from 402 to serving data |
| AI gate (bearer mode) | `backend/routes/ai.js` | see §4 — your entitlement + the mode flip turn AI into paid bearer auth |

Current stub returns `{entitled:false, reason:'no_subscription'}` and `issueLease` throws.
`jwksHandler` 503s. The three functions to implement are exactly the ones in
`02-agent-billing.md` §B2.

**DB is ready:** `comp_grants`, `ai_usage`, and all domain tables exist (migrations
`001`/`003`). Better Auth core tables exist (`002`, generated). You add `subscription` via
`@better-auth/stripe`'s generated migration as `backend/migrations/004_*.sql` (the runner
in `db.js` applies any new numbered file on boot — just drop it in).

## 2. Where to mount your routes (server.js is prepped)

`backend/server.js` has a **marked spot** for the Stripe webhook — right after the Better
Auth handler and **before** `express.json()`:

```js
// ⚠️ BILLING AGENT (B): mount the Stripe webhook HERE — before express.json() ...
```

That ordering is the classic integration bug; it's already solved for you — just insert
`app.post('/api/webhooks/stripe', express.raw({ type:'application/json' }), stripeWebhook)`
at that line. `routes/billing.js` mounts with the other routers (all after `express.json()`,
which is what you want for the JSON billing endpoints). The `/billing/success` +
`/billing/cancelled` static pages can be a tiny `routes/billing-pages.js` or inline `res.send`.

## 3. Stripe — LIVE account facts (read via MCP, {DATE-OF-READ})

**Account:** `acct_1Thq15DlENJF5h9J` — **AltakLabs Inc** (dba **CarXprt**), US/Delaware, USD,
statement descriptor `CARXPRT`, dashboard tz America/New_York.

**Payout-ready (the "are the bank details there" answer = YES):**
- `charges_enabled: true`, `payouts_enabled: true`, `details_submitted: true`
- Bank account attached: **Bank of America …6306**, USD, `default_for_currency`, `standard`
  payouts, schedule = manual/delay 2d. `external_accounts.total_count: 1`.
- `requirements.currently_due` / `past_due` = empty → nothing blocking.
- Capabilities active: card, link, cashapp, us_bank_account_ach, klarna, affirm, transfers…

**This account is the MAIN platform, already in production.** Active products are the
platform's memberships — **do not reuse or mutate these**:
- `prod_UnJxOS701dVlrm` "Pro Membership" (default price `price_1TnjK0DlENJF5h9JgvYW2SE7`)
- `prod_UnJxz40r2gaqyf` "Plus Membership" (`price_1TnjJ8DlENJF5h9JImWlLWBU`)
- `prod_UhMHhLdVSI1hOr` / `prod_UhMHAFr8n1TIHe` — "…- OLD" variants
- All `livemode: true`.

### Separation strategy (product owner's rule: extension billing must be separate)
Two ways to honor it — recommend **Option B** given the account is already live & verified:

- **Option B (recommended): same account, dedicated product.** Create a **new "Carxpert
  Extension" product + its own recurring price** (tag with `metadata.app: "carxpert-extension"`).
  Shares the verified bank/payouts (no re-KYC), cleanly separable in reporting by product.
  `STRIPE_PRICE_ID` points at the new price. Fastest path to revenue.
- **Option A: separate Stripe account.** Fully isolated books, but re-does all KYC + bank
  verification. Only worth it if finance/legal require separate legal-entity settlement.

**Develop in a Stripe SANDBOX (test mode), never against these live products.** Build the
new product/price in the sandbox first; mirror to live only at launch. `STRIPE_PRICE_ID`
differs per environment (sandbox price in staging, live price in prod) — never hardcode.

## 4. The AI-gate cutover you unblock (A5 part deferred to you + extension)

AI routes (`backend/routes/ai.js`) are **dual-mode** via `AI_AUTH_MODE` (default `token` =
legacy `x-carxpert-token`, so the shipped extension keeps working). When your `isEntitled`
is live **and** the extension ships sign-in, the "retire the token gate" step is just:
`AI_AUTH_MODE=bearer` + drop `x-carxpert-token` from the CORS header list + delete
`CARXPERT_TOKEN`. Bearer mode already enforces `requireUser → isEntitled (402) → daily
limits (429 via ai_usage)`; verified working end-to-end. Tracked as blocked task in the repo.

## 5. Env vars to add (Railway `carxpert-tools-backend` / staging)

Already set by core: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `EXTENSION_ID`,
`ADMIN_TOKEN`, `NODE_ENV=production`, `OPENAI_API_KEY`. **You add:**

```
STRIPE_SECRET_KEY          # sandbox sk_test_… in staging; live sk_… only in prod
STRIPE_WEBHOOK_SECRET      # from `stripe listen` (dev) or the dashboard endpoint (deployed)
STRIPE_PRICE_ID            # the new Carxpert-Extension price (sandbox price in staging)
LEASE_PRIVATE_KEY_PEM      # PKCS8 ES256 private key (see §6)
LEASE_KID                  # key id, e.g. lease-a8d940c9
```

Set via: `railway variables --service carxpert-tools-backend --set "KEY=value" --skip-deploys`
(confirm `railway status` shows env=staging, service=carxpert-tools-backend first — see the
infra memory note re: the service-link gotcha).

## 6. Lease keypair (ES256 / P-256) — generate + load

```bash
# private (PKCS8) + public
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out lease_private.pem
openssl pkey -in lease_private.pem -pubout -out lease_public.pem
# set on Railway (multiline is fine; or base64 if the CLI mangles newlines):
railway variables --service carxpert-tools-backend --set "LEASE_PRIVATE_KEY_PEM=$(cat lease_private.pem)" --skip-deploys
railway variables --service carxpert-tools-backend --set "LEASE_KID=lease-$(openssl rand -hex 4)" --skip-deploys
```

Use `jose` for signing (the one dep worth taking — hand-rolled JWS → alg-confusion bugs).
Serve the public JWK at `GET /.well-known/jwks.json`. Contract requires a node:test that
signs a lease and verifies it with **pure WebCrypto** (proves the MV3 worker can verify
without a library — the whole reason for ES256). Claims: `{ sub, dlr, dom: dealership.domains,
ent:true, iat, exp: iat+90*60 }`, header `{ alg:'ES256', kid }`.

## 7. Deps you'll add

`npm i @better-auth/stripe stripe jose` (root `package.json`; backend resolves upward).
Add the stripe plugin to `backend/auth.js` — there's a `plugins: [bearer()]` array and a
comment marking where the stripe plugin block goes (small, additive; coordinate so it doesn't
conflict with core edits — core is done, so the file is stable now).

## 8. Testing (from 02 + local specifics)

- `stripe listen --forward-to localhost:3737/api/webhooks/stripe` → get the signing secret →
  `STRIPE_WEBHOOK_SECRET`. Run the backend locally with `DATABASE_URL` (public proxy) +
  `PGSSL=require` (same as core's test setup; see infra memory).
- E2E: checkout with a **100%-off promo (no card, `payment_method_collection:'if_required'`)**
  → webhook → `isEntitled` true → `/api/me` returns a verifiable lease; cancel-at-period-end
  → still entitled; delete subscription → gate closes; `/api/billing/sync` reconciles.
- Unit: entitlement decision matrix (status × period-end × comp × dealership), lease
  claims/expiry, JWKS shape. Never log full Stripe objects (PII) — ids + status only.

## 9. Repo state

Branch `backend-core`, 6 phase commits (A0→A5), deployed green to staging. `npm run check`
+ `npm test` pass (2 DB tests need `DATABASE_URL`). Your work starts on a branch off `main`
(or off `backend-core` if it's merged by then); shared files are `auth.js` (add stripe
plugin) and `server.js` (mount webhook at the marked line) — both prepped for small,
additive edits.
