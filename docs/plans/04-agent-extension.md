# Agent brief — Extension (auth handshake, lease verifier, gate UX, sync client)

Read `00-architecture-contract.md` first — it defines the auth flow, lease format, and sync
contract you build against. This is the **third workstream** the contract carves out
(lines 323-329). Backend agents A and B are done: every route, the bearer handshake, the
ES256 lease, JWKS, and the sync/entitlement contracts already exist on staging. You own the
**client half** — nothing in `backend/` changes.

You own: everything under `extension/` and `scripts/build-extension.js`. The only backend
touch you may need is a **shared config value** (deployed URL) injected at build time — never
a route edit.

Product rules you are implementing (from the contract):
- Paid product, no free tier. Core paid value: List → fill Facebook Marketplace.
- **No blocking network call in the normal List-click path when a valid lease exists** — the
  lease is verified locally, offline. This is the whole reason it's ES256.
- Never auto-click Publish; never touch Facebook credentials/cookies.
- Client JS is tamperable; entitlement is enforced for **honest users**, not adversaries. Don't
  contort the UX to defeat someone editing their own bundle — the lease's domain claim + the
  server-side gates on AI/listings are the real enforcement.

## Where the extension is today (starting point)

Three MV3 contexts over `chrome.runtime` + `chrome.storage.local`, `EZLIST_*` messages:
- `background.js` (276 lines) — message router + privileged ops. Talks to the backend via
  `postBackend()` with a hardcoded `BACKEND_URL='http://127.0.0.1:3737'` and the **legacy
  `x-carxpert-token` header** (`BACKEND_TOKEN=''`). No bearer, no identity, no lease anywhere.
- `sidepanel.{html,js,css}` (500-line js) — the control surface (vehicle summary, editable
  description, prefs, AI buttons, Fill, the stats MVP). No auth/gate UI.
- `dealerContent.js` / `facebookContent.js` — extract + fill engines. `lib/mappers.js` is the
  shared US→UK term mapping. No gating.
- `manifest.json` — permissions `storage`, `sidePanel`. **No `identity` permission, no `key`
  (ID unpinned), localhost host-perms.** Content scripts match only `www.alexandriatoyota.com`
  + facebook.

Net: the auth/entitlement/sync surface is **greenfield**. Nothing to unwind.

New `chrome.storage.local` keys this workstream adds: `ezlistAuthToken` (bearer),
`ezlistMe` (cached `/api/me` profile+entitlement), `ezlistLease` (compact JWS + decoded
claims), `ezlistJwks` (cached public keys by kid), `ezlistEventQueue` (offline usage-event
buffer). Keep all existing `ezlist*` keys.

## C0 — Config hardening + env-aware backend URL + ID pinning

Foundation. Nothing else works until the extension has a stable ID and can reach the backend.

- **Pin the extension ID in every build.** Add the store `key` to `manifest.json` so the
  unpacked dev build and the store build share one ID (`ejagngoidhjkjoadbbijjkpdgelklael`).
  This is required because `chrome.identity.getRedirectURL()` derives the `chromiumapp.org`
  host from the extension ID, and the backend's `/api/auth/extension/finish` redirects to that
  exact host. If dev stays unpinned (path-derived ID), its redirect host won't match what the
  backend sends and `launchWebAuthFlow` never catches the callback. Pinning removes the whole
  `EXTENSION_IDS_DEV` divergence — one ID, dev and prod.
- Add `"identity"` to `permissions` (for `launchWebAuthFlow`).
- Add the **backend host permission**. Build-time, not hardcoded: local dev → `127.0.0.1:3737`,
  staging/prod → the deployed Railway URL. The dead localhost perms come out of the store build.
- **`scripts/build-extension.js` becomes env-aware.** One flag (`APP_ENV=local|staging|prod`)
  selects backend URL + host-perm + whether to keep dev affordances. This is the client side of
  the `isDeployed/isProduction/isStaging` split — same source, three targets, secrets/URLs
  injected not committed. Emit `dist/carxpert-extension-<env>-v<version>.zip`.
- Bump `minimum_chrome_version` stays 114 (side panel). Wire `/api/version`'s
  `minExtensionVersion` as a kill-switch: on boot, if the backend reports a higher min, the
  panel shows "update required" instead of the normal surface.

## C1 — Auth handshake (sign in / sign out / bearer storage)  ← unblocks A5 + B4

The launch blocker. Backend routes already exist (`/start`, `/finish`, `/exchange`).

- **Sign in** (background, on `EZLIST_SIGN_IN`):
  1. `chrome.identity.launchWebAuthFlow({ url: <backend>/api/auth/extension/start,
     interactive: true })`.
  2. Backend 302s through Google → `/finish` → `https://<id>.chromiumapp.org/?code=<code>`.
  3. Parse `code` from the returned redirect URL. **Never accept a token in the URL — only the
     one-time code.**
  4. `POST /api/auth/extension/exchange { code }` → `{ token }`. Store as `ezlistAuthToken`.
- **Attach bearer to every backend call.** Extend `postBackend()` / the fetch helpers in
  `background.js` to send `Authorization: Bearer <ezlistAuthToken>`. Keep sending
  `x-carxpert-token` **during the transition** so nothing breaks before the A5 flip — this is
  dual-auth on the client to mirror the backend's dual-mode AI gate. Drop the legacy header in
  C6 alongside A5.
- **`EZLIST_ME`**: `GET /api/me` → cache `{ user, dealership, entitled, reason, subscription,
  lease }` as `ezlistMe`. This is the single source the gate UX reads.
- **Sign out** (`EZLIST_SIGN_OUT`): clear `ezlistAuthToken`, `ezlistMe`, `ezlistLease`. (No need
  to revoke server-side in v1.)
- 401 handling: any bearer call returning 401 clears the token and drops the panel to the
  signed-out gate — don't loop.

Landing C1 (extension can sign in + carry a bearer) is what lets **A5** flip
`AI_AUTH_MODE=bearer` and **B4** ship live billing. Sequence this first.

## C2 — Lease verifier (offline, pure WebCrypto ES256)

The performance/offline contract: List/Fill must not block on the network when a lease is valid.

- Fetch `GET /.well-known/jwks.json`, cache as `ezlistJwks` keyed by `kid`. Refetch only on an
  unknown `kid` (rotation) — not per verify.
- `verifyLease(jws)` in the **background worker** (or a `lib/lease.js` shared module):
  - Split the compact JWS, base64url-decode header + payload.
  - Look up the public JWK by header `kid`; `crypto.subtle.importKey('jwk', jwk,
    {name:'ECDSA', namedCurve:'P-256'}, false, ['verify'])`.
  - `crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, key, sig, signingInput)`.
  - Check `exp` with **60s skew** (matches the contract), and that `dom` (lease's exact
    dealership domains) covers the host in play.
  - No library. Verifying the node:test in `entitlement/keys.test.js` already proves this shape
    works in pure WebCrypto — port that verify path.
- **Cache the decoded lease** (`ezlistLease`) with its claims. MV3 workers get killed between
  events, so read the lease from storage on each gate check, not from an in-memory global.
- **Refresh** via `/api/me` when <10 min remain (TTL is 90 min). If the backend is unreachable
  but the cached lease is still valid and unexpired → **allow List/Fill anyway** (offline
  tolerance). Expired / invalid signature / domain mismatch → block and route to the gate.

## C3 — Gate UX (side panel): the `reason` state machine

`/api/me` returns `{ entitled, reason }`. Map each state to exactly one panel screen — this is
the product's onboarding funnel:

| `reason` (or state) | Panel shows |
|---|---|
| no `ezlistAuthToken` | **Sign in with Google** button (fires `EZLIST_SIGN_IN`) |
| `no_dealership` | Link/request your dealership (calls `/api/dealerships/resolve` → link, or `request`) |
| `no_subscription` / `expired` | **Subscribe** (`$89.99/mo`) → `POST /api/billing/checkout` → open `{url}` in a tab |
| `ok` (entitled + valid lease) | Normal control surface (today's panel) |

- **Gate List/Fill on a valid lease.** When not entitled, clicking a ⚡ List button or **Fill
  listing** routes to the gate screen instead of writing a draft / filling — don't half-run.
- **Checkout return**: after opening the Checkout URL, poll `/api/me` (or `POST
  /api/billing/sync` — the webhook-delay recovery path B built) until `entitled` flips, then drop
  the gate. A "I've paid, refresh" button calls `sync`.
- **Manage billing**: a portal link (`POST /api/billing/portal` → open `{url}`) on the entitled
  screen.
- Read `ezlistMe`/`ezlistLease` from storage and repaint via `storage.onChanged` (same pattern
  the green "✓ Added" cards already use).

## C4 — Content-script gating (dealer + Facebook)

- `dealerContent.js`: only inject the ⚡ List buttons when a valid lease covers **this dealer
  host** (the lease `dom` claim). Otherwise show a single subtle "Sign in to list" affordance
  that opens the side panel — don't paint dozens of dead buttons.
- `facebookContent.js`: the fill engine is already local. Gate the **auto-fill trigger** on a
  valid lease as belt-and-braces (a draft shouldn't exist without entitlement anyway, since the
  panel/dealer paths gate first). Publish-detection + green "✓ Added" stay as-is.
- The `dom`-match check is the honest-user boundary: a lease for dealership X doesn't light up
  dealership Y. Server-side AI/listings gates catch the rest.

## C5 — Sync client + offline event queue + stats

Backend contract is `POST /api/listings/sync { listings, events }` (auth only, not entitlement)
+ `GET /api/listings` (entitled).

- **On sign-in**: bulk-upload existing local `ezlistListings` (the stats-MVP store) via `sync`.
  Idempotent by `(owner_id, client_key)` — the backend allows first batches ≥200, so send it all.
- **On each publish** (the existing publish-detection): `sync` the new listing + a
  `publish_detected` / `fill_completed` event (the latter carries the per-field fill report the
  panel already computes).
- **Offline event queue** (`ezlistEventQueue`): every `usage_event` gets a client-generated uuid
  (idempotency key — backend does `on conflict (id) do nothing`). Buffer in storage; flush on the
  next successful backend contact. Never lose a `marked_sold` to a dropped request.
- **Stats view**: pull `GET /api/listings` to back the Sales-overview screen (currently
  local-only per the stats-MVP memory) — server data becomes the source of truth once signed in,
  local remains the offline fallback.
- **Views** (optional, later): scrape `marketplace/you/selling` for `views_count`, send as
  `views_observed` events. Cheap, unlocks trend charts. Defer if it fights Facebook's DOM.

## C6 — Store build + cutover coordination

- Build script produces the **store zip**: deployed backend URL, pinned prod ID, `identity` +
  facebook + dealer + backend host-perms only. **No** localhost perms, **no** dev IDs, **no** dev
  affordances. Minimal + justified for review.
- **Drop the legacy `x-carxpert-token`** from `background.js` — this is the client side of A5.
  Coordinate the three-way flip: C6 (extension ships bearer-only) ⇄ **A5** (`AI_AUTH_MODE=bearer`,
  header out of CORS) ⇄ **B4** (live Stripe keys). Order: extension in store review → A5/B4 on
  staging verified → promote.
- Version bump + honor `/api/version` `minExtensionVersion` (the kill-switch from C0).

## Testing / verification

- **Local fast loop** (per the env split we agreed): unpacked pinned build → local backend
  (`APP_ENV=local`) → local Postgres → **dev auth bypass** seeds `local-dev-user`, auto-links
  Alexandria, inserts a `comp_grants` row (satisfies the real `isEntitled`: dealership + comp).
  Gate the bypass on `!isDeployed() && APP_ENV==='local'` — **never** an env var alone. Iterate
  List → Fill → publish → stats with zero Google/Stripe friction.
- **Staging E2E**: real Google sign-in + Stripe **test-mode** checkout (100%-off promo, no card)
  → webhook → `isEntitled` true → `/api/me` lease → verify locally → List/Fill unblocked. Proves
  the whole funnel behind the paywall on safe money.
- **Live Chrome testing** is documented in `docs/testing-auth-and-chrome.md` (Path B:
  `./scripts/open-test-chrome.sh` + chrome-devtools-mcp over the WSL2⇄Windows debug port; extension
  pages are hidden from `list_pages`, find them via `curl 127.0.0.1:9222/json`).
- Unit-test the lease verifier against a backend-signed fixture (import the JWK, verify, assert
  exp/dom rejection paths). Keep it in `lib/` so it runs under `npm test`.

## Sequencing

**C0 → C1 → C2** is the critical path and unblocks the whole launch — C1 (sign-in + bearer) is
what lets A5 flip and B4 go live. C3 makes it usable; C4/C5 make it complete; C6 is the store
cutover. C5's views scraping and offline-queue polish can trail the first store submission.

## Explicitly not yours

Backend routes, the auth handshake server-side, lease **signing**, JWKS **serving**, Stripe,
entitlement decisioning — all built (A + B). You **consume** those contracts. The one backend-
adjacent item is the deployed-URL value injected at build time and the `EXTENSION_ID` /
`EXTENSION_IDS_DEV` env the backend already reads — coordinate, don't edit routes.
