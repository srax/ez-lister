# Carxpert Production Backend — Architecture Contract (v1)

This is the shared contract both backend agents build against. Read this first, then your
own brief (`01-agent-backend-core.md` or `02-agent-billing.md`). If you need to deviate
from this contract, update this file in the same PR and call it out in the PR description.

Product rules (non-negotiable, carried from the product plan):
- Paid product, no free tier. Core paid value: List → fill Facebook Marketplace.
- No blocking network call in the normal List-click path when a valid lease exists.
- Never auto-click Publish; never touch Facebook credentials/cookies server-side.
- Client JS is tamperable; entitlement is enforced for honest users, not adversaries.

## Runtime topology

One Railway service (Node, Express, ESM) + Railway Postgres. The sold-scan worker runs
in-process on an interval (no separate service in v1). The Chrome extension
(`ejagngoidhjkjoadbbijjkpdgelklael`) talks to the backend only from its background
service worker with a Bearer token.

```
extension bg worker ──Bearer──▶ Express API ──▶ Postgres
                                   │  ├─ Better Auth (Google OAuth, sessions)
                                   │  ├─ Stripe (checkout/portal/webhooks)
                                   │  └─ OpenAI (AI describe/translate)
                                   └─ in-process hourly sold-scan worker ──▶ dealer sites
```

## Backend module layout & ownership

```
backend/
  package.json          # "type": "module" — backend goes ESM (Better Auth requires it)   [A]
  server.js             # express bootstrap, route mounting, CORS, error handler          [A]
  db.js                 # pg pool + tiny versioned-migration runner                       [A]
  auth.js               # Better Auth instance (google, bearer; B adds stripe plugin)     [A, B edits]
  migrations/           # 001_*.sql ... numbered, forward-only                            [A owns runner; each agent adds own files]
  routes/
    meta.js             # /health, /api/version                                           [A]
    me.js               # /api/me (profile + dealership + lease)                          [A shell, calls entitlement/]
    dealerships.js      # resolve/link/request                                            [A]
    listings.js         # /api/listings/sync, /api/listings                               [A]
    ai.js               # port of existing describe/translate + gates/limits              [A]
    billing.js          # /api/billing/{plan,checkout,portal,sync}                        [B]
    admin.js            # ADMIN_TOKEN-gated ops                                           [A; B adds comp-grant]
  webhooks/stripe.js    # raw-body webhook handler                                        [B]
  entitlement/
    index.js            # isEntitled(userId), issueLease(user, dealership)                [B]
    keys.js             # ES256 keypair loading, JWKS, kid                                [B]
  worker/
    soldScan.js         # hourly loop, state machine                                      [A]
    adapters/dealeron.js# sitemap.aspx roster fetch + parse                               [A]
  ai.js, normalize.js   # existing files, keep                                            [A]
  firecrawl.js          # keep on disk, NEVER mounted on a route in production            [A]
```

[A] = backend-core agent, [B] = billing agent.

**The seam:** `entitlement/index.js` is the only module both sides depend on. Contract:

```js
// entitlement/index.js  (B implements; A consumes. A stubs it until B lands.)
export async function isEntitled(userId)
// → { entitled: boolean, reason: 'ok'|'no_subscription'|'expired'|'no_dealership', periodEnd: Date|null }
// entitled = (subscription status in ('active','trialing') with period end in future
//             OR valid comp_grants row) AND user has a linked supported dealership.

export async function issueLease(user, dealership)
// → compact JWS string (see Lease below). Throws if not entitled.

export function jwksHandler(req, res)   // GET /.well-known/jwks.json
```

## Auth flow (extension ⇄ backend)

1. Extension calls `chrome.identity.launchWebAuthFlow({ url: <backend>/api/auth/extension/start, interactive: true })`.
2. `/api/auth/extension/start` 302s into Better Auth's Google authorize flow with
   `callbackURL=/api/auth/extension/finish`.
3. `/api/auth/extension/finish` runs with the Better Auth session cookie set by the OAuth
   callback. It mints a **one-time code** (row in `extension_auth_codes`: code, user_id,
   expires_at = now + 60s, used = false) and 302s to
   `https://ejagngoidhjkjoadbbijjkpdgelklael.chromiumapp.org/?code=<code>`.
4. Extension POSTs `/api/auth/extension/exchange { code }` → `{ token }` where token is a
   Better Auth session token (enable the `bearer` plugin). Single-use, constant-time
   compare, delete on use.
5. All subsequent API calls: `Authorization: Bearer <token>`.

Never put a bearer token in the redirect URL — only the one-time code.
Better Auth `trustedOrigins` must include `chrome-extension://ejagngoidhjkjoadbbijjkpdgelklael`.
Store email + name only. Google is the only provider in v1.

**Extension ID pinning:** the ID above is only stable if the dev/unpacked build carries the
store `key` in `manifest.json`. This is extension-side work but the backend must treat the
ID as config (`EXTENSION_ID` env, plus `EXTENSION_IDS_DEV` allowlist in non-prod).

## Entitlement lease

- Format: compact JWS, **ES256** (P-256) — chosen because MV3 service workers verify it
  with plain WebCrypto (`crypto.subtle.verify`), no library.
- Header: `{ alg: 'ES256', kid: <LEASE_KID> }`
- Claims: `{ sub: userId, dlr: dealershipId, dom: [exact domains], ent: true, iat, exp }`
- TTL 90 minutes. Verifier allows 60s clock skew.
- Keys: `LEASE_PRIVATE_KEY_PEM` (PKCS8) + `LEASE_KID` from env. Public side served at
  `GET /.well-known/jwks.json`. Rotation = add new kid, keep old in JWKS for ≥2h.
- `/api/me` returns a fresh lease whenever the user is entitled.

Extension behavior (for reference; extension workstream implements): verify locally before
paid actions; refresh via `/api/me` when <10 min left; if backend unreachable but lease
valid, allow List/Fill until expiry; expired/invalid/mismatched-domain → block + gate.

## API surface

| Route | Auth | Owner | Notes |
|---|---|---|---|
| `GET /health` | none | A | minimal `{ok:true}` — no key/model info in prod |
| `GET /api/version` | none | A | `{ api, minExtensionVersion }` — kill switch for old builds |
| `GET /.well-known/jwks.json` | none | B | lease public keys |
| `GET /api/auth/*` | — | A | Better Auth handler mount |
| `GET /api/auth/extension/start` | none | A | begins launchWebAuthFlow journey |
| `POST /api/auth/extension/exchange` | none (code) | A | one-time code → bearer token |
| `GET /api/me` | bearer | A shell / B lease | profile, dealership (+config), subscription summary, `lease` (null if not entitled) |
| `POST /api/dealerships/resolve` | bearer | A | URL/fingerprints in → matched dealership or `unsupported` |
| `POST /api/dealerships/link` | bearer | A | link user ⇄ supported dealership (one per user) |
| `POST /api/dealerships/request` | bearer | A | record unsupported dealership request |
| `POST /api/listings/sync` | bearer | A | batch listings + events upsert; **auth only, not entitlement** |
| `GET /api/listings` | bearer + entitled | A | user's listings for stats view |
| `POST /api/ai/describe` | bearer + entitled | A | gpt-4o-mini; daily limit |
| `POST /api/ai/translate` | bearer + entitled | A | gpt-4o; daily limit |
| `GET /api/billing/plan` | none | B | price/value copy from backend config |
| `POST /api/billing/checkout` | bearer + linked dealership | B | Stripe Checkout session URL |
| `POST /api/billing/portal` | bearer | B | Billing Portal URL |
| `POST /api/billing/sync` | bearer, rate-limited | B | pull subscription state from Stripe (webhook-delay recovery) |
| `POST /api/webhooks/stripe` | signature | B | **raw body** route, mounted before json parser |
| `GET/POST /api/admin/*` | ADMIN_TOKEN | A+B | dealer requests list, manual link, comp grant, fill-accuracy report |

Dead in production: `/api/listings/extract` (Firecrawl), HTML fixtures. Do not mount them
when `NODE_ENV=production`. The old `x-carxpert-token` shared-secret gate is retired once
bearer auth lands (build script token injection becomes a no-op).

CORS: exact-origin allowlist — `chrome-extension://<EXTENSION_ID>` (+ dev IDs outside
production). No wildcard in production. All extension fetches already route through the
background worker, so this is the only origin needed.

## Database

**Better Auth CLI owns** (generated, do not hand-edit): `user`, `session`, `account`,
`verification`, and `subscription` (from `@better-auth/stripe`). Better Auth uses TEXT ids;
all our FKs are text. No organization plugin in v1 — but every domain table carries a
nullable `dealership_id` so org/dealership billing can be added without reshaping.

**Carxpert migrations own** (numbered SQL in `backend/migrations/`, run by `db.js` with a
`schema_migrations` table):

```sql
create table dealerships (
  id            text primary key,
  name          text not null,
  platform      text not null,              -- 'dealeron' | 'cdk' | 'dealerdotcom' | ...
  status        text not null default 'supported',  -- 'supported' | 'detected' | 'unsupported'
  timezone      text not null default 'America/New_York',
  config        jsonb not null default '{}' -- adapter params: inventoryUrls, sitemapUrl,
                                            -- photo pattern, default location, etc.
);
create table dealership_aliases (           -- exact-match only; no fuzzy
  domain        text primary key,           -- lowercased host, e.g. 'www.alexandriatoyota.com'
  dealership_id text not null references dealerships(id)
);
create table user_dealerships (             -- one per user in v1
  user_id       text primary key,
  dealership_id text not null references dealerships(id),
  linked_at     timestamptz not null default now()
);
create table dealer_requests (
  id            text primary key,
  user_id       text not null,
  raw_input     text not null,
  normalized_domain text,
  detected_platform text,                   -- fingerprint result, for triage
  fingerprints  jsonb,
  created_at    timestamptz not null default now()
);

create table listings (                      -- extends existing backend/schema.sql draft
  id            text primary key,
  owner_id      text not null,
  dealership_id text,
  client_key    text not null,               -- VIN(upper) → stock → sourceUrl
  vin           text,                        -- checksum-validated or null
  stock         text,
  title         text, year int, make text, model text,
  price         numeric(12,2),
  platform      text not null default 'fb',
  status        text not null default 'listed',   -- 'listed' | 'sold' | 'removed'
  sold_source   text,                        -- 'manual' | 'scan'  (manual always wins)
  listed_at     timestamptz,
  sold_at       timestamptz,
  sold_price    numeric(12,2),
  source_url    text,
  facebook_listing_id  text,
  facebook_listing_url text,
  facebook_published_at timestamptz,
  views_count   int,                         -- latest observation (history in snapshots)
  views_observed_at timestamptz,
  last_seen_in_inventory_at timestamptz,     -- sold-scan bookkeeping
  first_missed_at timestamptz,               -- null when present; set on first miss
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, client_key)
);

create table listing_view_snapshots (        -- append-only; ~free, unlocks trends later
  listing_id    text not null references listings(id),
  views_count   int not null,
  observed_at   timestamptz not null,
  primary key (listing_id, observed_at)
);

create table usage_events (                  -- retained 90 days (daily delete job)
  id            text primary key,            -- client-generated uuid = idempotency key
  user_id       text not null,
  type          text not null,               -- list_clicked | fill_completed | publish_detected
                                             -- | marked_sold | marked_sold_undo | views_observed
  client_key    text,
  data          jsonb,                       -- fill_completed carries per-field fill report
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now()
);

create table dealer_inventory_scans (
  id            text primary key,
  dealership_id text not null,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  ok            boolean,
  vin_count     int,
  source        text,                        -- 'sitemap' | 'srp'
  error         text
);

create table extension_auth_codes (
  code          text primary key,
  user_id       text not null,
  expires_at    timestamptz not null,
  used          boolean not null default false
);

create table comp_grants (                   -- entitlement without Stripe (friends/testing)
  user_id       text primary key,
  expires_at    timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);

create table ai_usage (
  user_id       text not null,
  day           date not null,
  describe_count  int not null default 0,
  translate_count int not null default 0,
  primary key (user_id, day)
);
```

## Sync contract (`POST /api/listings/sync`)

```jsonc
{
  "listings": [{
    "clientKey": "5TDGZRBH...", "vin": "...", "stock": "...",
    "title": "...", "year": 2025, "make": "...", "model": "...",
    "price": 54970, "sourceUrl": "...", "platform": "fb",
    "status": "listed", "listedAt": "...", "soldAt": null, "soldPrice": null,
    "facebookListingId": null, "facebookListingUrl": null, "facebookPublishedAt": null,
    "viewsCount": null, "viewsObservedAt": null
  }],
  "events": [{ "id": "<uuid>", "type": "fill_completed", "clientKey": "...",
               "occurredAt": "...", "data": { "fields": [{ "name": "Mileage", "ok": false, "msg": "..." }] } }]
}
```

Rules:
- Upsert on `(owner_id, client_key)`. Duplicate VINs across users are fine.
- Valid VIN (ISO 3779 check digit) required for a listing to participate in sold-scan;
  invalid VIN → store with `vin = null`, still counts in stats the user sees.
- Status merge precedence: `sold_source='manual'` beats scanner; scanner never overrides a
  manual sold; a `marked_sold_undo` event reverts to `listed` and clears sold fields.
- Server `listed` starts only from publish detection (extension sends only published cars).
- Events insert with `on conflict (id) do nothing` — client can retry batches safely.
- First sign-in: extension bulk-uploads its existing local `ezlistListings` (idempotent by
  design). Backend needs no special casing, but don't reject large first batches (allow ≥200).

## Environment variables (Railway)

```
DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID,
LEASE_PRIVATE_KEY_PEM, LEASE_KID,
ADMIN_TOKEN, OPENAI_API_KEY,
EXTENSION_ID (=ejagngoidhjkjoadbbijjkpdgelklael), EXTENSION_IDS_DEV (non-prod only),
MIN_EXTENSION_VERSION
```

Secrets only in Railway env vars; nothing checked in.

## Sequencing / merge order

1. **A0** — Express+ESM skeleton, `db.js` + migrations runner, `/health`, `/api/version`,
   port AI routes as-is (temporary open gate), deploy green on Railway with Postgres.
2. **A1** — Better Auth core + Google + bearer plugin + extension start/finish/exchange +
   `/api/me` with `lease: null` and stubbed `entitlement/` (isEntitled → `{entitled:false}`).
   **B starts after A1 merges.**
3. **B1** — `@better-auth/stripe` plugin + subscription schema + checkout/portal/webhooks/sync.
4. **B2** — `entitlement/` real implementation + lease signing + JWKS; `/api/me` now returns leases.
5. **A2** — dealerships: resolve/link/request + seed migration for Alexandria Toyota.
6. **A3** — listings sync + events + views ingest + `GET /api/listings`.
7. **A4** — sold-scan worker + DealerOn adapter.
8. **A5** — admin routes, AI entitlement gate + daily limits, prod route lockdown, retire
   `x-carxpert-token`.

A and B work on separate branches off main; the only shared files are `auth.js` (B adds
the stripe plugin block) and `server.js` (each mounts own routes) — keep those edits
small and additive to avoid conflicts.

## Explicitly out of scope for both agents (third workstream: extension)

Background-worker lease verifier, side-panel auth/gate UX, dealer/FB content-script
gating, sync client + offline event queue, views scraping of `marketplace/you/selling`,
manifest changes (`identity` permission, backend host permission, manifest `key` pinning,
optional host permissions + dynamic content-script registration for future dealers).
The API/lease/sync contracts above are written so that work can proceed independently.
