# Agent brief — Backend Core (auth foundation, dealerships, listings, sold-scan worker)

Read `00-architecture-contract.md` first. You own everything in the backend except
billing/Stripe and the `entitlement/` module (the billing agent owns those). You provide
the skeleton they build on, so your phase A0/A1 blocks them — land it first and keep it
small.

Working style: this repo is plain JavaScript, strict mode, two-space indent, small
helpers, early returns (see `AGENTS.md`). The backend moves to ESM (`backend/package.json`
with `"type": "module"`) because Better Auth is ESM-only — the extension stays untouched.
Update root `npm run check`/`npm test` so they still pass (node --check chokes on ESM in
`.js` unless the nearest package.json says module — verify both trees still check).
Add real tests (`node:test`) for every pure function you write; the repo already has
`backend/normalize.test.js` as the pattern.

## A0 — Skeleton (small PR, unblocks everything)

- Express app in `server.js`; keep the existing `/health` (strip AI/model details in
  production) and add `GET /api/version` → `{ api: '1', minExtensionVersion: process.env.MIN_EXTENSION_VERSION }`.
- `db.js`: `pg` Pool + a ~40-line migration runner: read `migrations/*.sql` sorted,
  apply those not in `schema_migrations`, each in a transaction. Forward-only. Run on boot.
- Port `/api/ai/describe` and `/api/ai/translate` onto Express unchanged (keep the
  in-memory rate limit for now; entitlement gating comes in A5).
- CORS middleware per contract (exact chrome-extension origins). Central error handler
  that never leaks stack traces in production.
- Do NOT mount firecrawl/fixtures routes when `NODE_ENV=production`.
- Railway: Postgres attached, deploy green, `/health` passes. Keep `railway.json` startCommand.

## A1 — Better Auth + extension auth flow

- Better Auth instance in `auth.js`: Google provider, `bearer()` plugin, `trustedOrigins`
  including the extension origin. Generate auth tables with the Better Auth CLI; commit the
  generated migration output so deploys are reproducible.
- The three extension endpoints from the contract (`start`, `finish`, `exchange`).
  `finish` must require a live Better Auth session (it runs inside the launchWebAuthFlow
  window right after the Google callback), mint the one-time code, and redirect to the
  chromiumapp URL. `exchange`: single-use, 60s TTL, constant-time compare, returns the
  bearer session token. Test the code lifecycle (expiry, reuse rejection) with node:test.
- `requireUser` middleware (bearer → Better Auth session → `req.user`).
- `/api/me` shell: `{ user, dealership, subscription: null, lease: null }`, calling the
  stubbed `entitlement/index.js` you create (isEntitled → `{entitled:false, reason:'no_subscription'}`,
  issueLease → throws). The billing agent replaces the stub internals; don't change its API.

Gotcha: Google OAuth client is type "Web application" with the backend callback URL —
`launchWebAuthFlow` is just a popup browser window, nothing Chrome-specific on the Google side.

## A2 — Dealership onboarding & normalization (the part to get right)

This is the structural investment: v1 supports exactly one dealership, but the shape you
build here is how every future dealer gets added without code rewrites.

**Model: platform adapters × dealership config.** A *platform* (DealerOn, CDK, Dealer.com,
DealerInspire…) defines *how* to read a site; a *dealership* row selects a platform and
carries instance params in `config` jsonb (inventory URLs, sitemap URL, photo pattern,
default listing location, timezone). The extension's `dealerContent.js` is already a
DealerOn client-side adapter; the backend mirrors that: `worker/adapters/dealeron.js` is
the server-side one. Adding a dealer on a supported platform = one `dealerships` +
`dealership_aliases` insert (admin endpoint). Adding a platform = one new adapter file on
each side.

**URL normalization** (`normalizeDealerUrl(raw)` — pure, heavily tested):
1. Trim; prepend `https://` if scheme missing; parse with `URL` (invalid → error).
2. Lowercase host, strip port, drop path/query/hash entirely.
3. Follow redirects server-side, max 3, GET with ~5s timeout, only http(s), and record the
   final host too (dealers love `mydealership.com` → `www.mydealership.com`).
4. Match **both** the input host and final host against `dealership_aliases` — exact match
   only, no fuzzy/suffix matching (contract requirement: a lookalike domain must not link).

**`POST /api/dealerships/resolve`** accepts `{ url?, fingerprints? }`:
- Alias hit → `{ supported: true, dealership: { id, name, platform, config-subset } }`.
- Miss → run platform fingerprinting and return
  `{ supported: false, detectedPlatform, confidence }`, and (if the user asks, or always)
  record a `dealer_requests` row for triage.

**Platform fingerprinting** — build it as a scored evidence table, not a boolean:
- Server-side evidence (fetch homepage + try well-known paths):
  DealerOn → `/sitemap.aspx` returns an inventory-style page; body mentions DealerOn;
  `searchnew.aspx`/`searchused.aspx` exist; `/inventoryphotos/` image paths.
  Other platforms: add fingerprint rows as research lands (Dealer.com: `*.dealer.com`
  assets; DealerInspire: `dealerinspire` script hosts; CDK: `cdk`-hosted assets) — start
  the table with DealerOn fully verified and the rest marked provisional.
- Client-side evidence (the extension can POST what it sees in the live DOM, which beats
  server fetches when sites bot-wall): presence of `[data-vehicle-information][data-vin]`,
  `data-dotagging-*` attributes → DealerOn. Accept these in `fingerprints` and score them.
- Score ≥ threshold → `detected_platform` recorded on the request row. This is triage
  metadata for you to onboard dealers quickly, NOT auto-support — v1 support list is
  curated by hand via admin.

**Linking (`POST /api/dealerships/link`)**: only for `status='supported'` dealerships;
insert `user_dealerships` (one per user — reject a second link in v1, switching is
admin-only). Auto-link path: extension detects the user is on a supported dealer page and
calls resolve→link with that URL.

**Seed migration**: Alexandria Toyota — platform `dealeron`, aliases
`alexandriatoyota.com` + `www.alexandriatoyota.com`, timezone `America/New_York`, config:
`{ location: 'Alexandria, VA', sitemapUrl: 'https://www.alexandriatoyota.com/sitemap.aspx',
inventoryUrls: [searchused.aspx, searchnew.aspx, certified-pre-owned.html] }`.

`/api/me` includes the linked dealership's config subset (platform, location, domains) —
that's what lets the extension become config-driven per dealer later instead of
hardcoding `Alexandria, VA`.

## A3 — Listings sync + events

Implement the sync contract exactly as specified in `00-architecture-contract.md`
(upsert semantics, VIN check-digit validation — write `isValidVin()` with tests including
`I/O/Q` rejection and the check digit, event idempotency via `on conflict do nothing`,
manual-beats-scanner precedence, views snapshot append plus latest-on-listing).
`GET /api/listings` (entitled only) returns the user's listings; the extension keeps
computing display stats client-side for now.

Also: a daily cleanup job (piggyback on the worker loop) deleting `usage_events` older
than 90 days.

The `fill_completed` event's `data.fields` payload is the **fill-accuracy eval loop**:
add `GET /api/admin/fill-accuracy` that aggregates per-field ok-rate over the last N days
(group by field name). This turns every real listing into an eval case and tells you when
Facebook changes the form before users complain.

## A4 — Sold-detection worker

In-process loop, every hour, 24/7, jittered start (±5 min).

Per scan cycle, for each dealership with ≥1 tracked listing (`status='listed'`, valid VIN)
owned by a user whose entitlement is active (`isEntitled` — skip paused users):
1. Fetch the VIN roster via the platform adapter. **DealerOn tier order:**
   `sitemap.aspx` first (single page, VIN-bearing inventory roster — verified in
   `research.md/DealerOnformat.md`), fall back to paginating the configured
   `inventoryUrls` (SRP pages) only if the sitemap fetch fails or parses to implausibly
   few VINs. Use conditional GET (ETag/If-Modified-Since) when offered, a honest static
   User-Agent, and per-host politeness (≥2s between requests).
2. **Plausibility gate:** a scan only counts if it completed without errors AND the VIN
   count is plausible (≥ max(10, 30% of the previous successful count)). Implausible or
   failed scans → record in `dealer_inventory_scans` with `ok=false` and change NO
   listing state.
3. For each tracked listing: VIN present anywhere in the roster → clear `first_missed_at`,
   set `last_seen_in_inventory_at`. VIN absent → if `first_missed_at` is null set it to
   now; else if `now - first_missed_at >= 20 hours` → mark `status='sold'`,
   `sold_source='scan'`, `sold_at=now`.

   The 20-hour spacing is deliberate and overrides "two consecutive misses" from the
   product draft: with an hourly worker, two consecutive misses is only ~2 hours, and
   DealerOn sites refresh inventory roughly daily — a repricing/temporarily-hidden unit
   would false-positive. Two misses on effectively different days is what the DealerOn
   research supports. Reappearance after `sold_source='scan'` → flip back to `listed`,
   clear sold fields (never flip back a `sold_source='manual'`).
4. On entitlement resume (user was paused): clear `first_missed_at` older than 48h before
   judging, so stale misses accumulated around the pause don't insta-sell cars.

Store only Carxpert-tracked listings — never persist the full dealer inventory in v1
(scan rows keep just counts/timestamps/errors).

Note the ToS reality from the research: these sites carry anti-scraping language. Hourly
conditional-GET of one sitemap page per dealership is the minimal-footprint version; the
long-term correct path is dealer-authorized syndication feeds (the dealer is our
customer — ask them), and the adapter interface should make a feed-based adapter a
drop-in later.

## A5 — Hardening & admin

- AI routes: `requireUser` + `isEntitled` + daily limits via `ai_usage` upsert
  (100 describe + 100 translate/day, `America/New_York` day boundary via the user's
  dealership timezone). 429 with a clear message on limit.
- Admin router (`ADMIN_TOKEN` header, constant-time compare): list dealer requests,
  create dealership + aliases, manually link/unlink a user, fill-accuracy report,
  recent scans. CLI/curl only — no UI.
- Retire the `x-carxpert-token` gate; remove the header from CORS allowlist.
- Production route audit: firecrawl/fixtures unreachable, `/health` minimal, no wildcard
  CORS, stack traces suppressed.

## Definition of done

- `npm run check` and `npm test` green (unit tests: URL normalization, VIN validation,
  fingerprint scoring, sync upsert/precedence via a pg test db or query-builder tests,
  auth-code lifecycle, sold-scan state machine as a pure function over roster+listing state).
- Deployed on Railway with migrations applied on boot; `/health`, `/api/version` public;
  a curl script or notes in the PR showing the full auth → link → sync → scan happy path.
- No secrets in the repo; every new env var documented in `backend/.env.example`.
