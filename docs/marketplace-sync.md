# Marketplace Sync — Facebook observation, reconciliation & stats

Status: **finalized plan, not yet built.** Owner: srax. Extends the existing
listings registry + dealer-side sold-scan. This is the "what needs my attention
today?" layer for Facebook Marketplace.

Aligned with `docs/implementation.md` (Organizations V1). Migration `009` is
**reserved for this work** by that plan (§7); org work runs 010+. This layer
consumes the multi-tenant model (workspaces, rooftops, seats, lease V2) rather
than the old one-dealership-per-user assumption — see §1a.

## 1. The model

Three roles, one source of truth:

- **Backend = brain and memory.** All normalized data, matching, reconciliation,
  and task computation live here. The future mobile app reads the same system.
- **Extension = Facebook's eyes and hands.** It observes the seller's own
  Marketplace pages while the browser is open, posts observations, and executes
  queued actions in-session. It holds no durable state that matters.
- **Mobile app (later) = remote control.** Views stats, receives alerts, and
  *enqueues* actions. It never touches Facebook; the extension drains the queue
  when a session is available.

### Two separate truths — never blended

| Truth | Freshness | Source |
|---|---|---|
| **Dealer inventory** (availability, price, mileage) | Live | Backend scanner / adapters |
| **Facebook** (status, price, clicks, renewal) | *As of last observation* | Extension reads, timestamped |

Every Facebook value carries `observed_at` and is shown with its age. **We never
render a stale Facebook number as if it were live.** The urgent signal — "this car
sold" — comes from the always-live *dealer* side, so freshness anxiety on the FB
side is bounded: FB is the confirmation surface, not the trigger.

## 1a. Multi-tenant alignment (workspace / rooftop / seat)

**One Facebook account can span multiple rooftops and workspaces.** A salesperson
at "Stevens Auto Group" may hold seats at *Stevens Toyota* and *Stevens Hyundai*
(two `dealership_id`s, two seats, one org workspace) and list both from the same
FB account — and may *also* have an independent personal workspace on that same
FB account. So a single Selling-page read is a **mixed bag** of listings belonging
to different rooftops and even different workspaces. Attribution is therefore
**per-listing, resolved by the match — never assumed from the read.**

- **Attribution.** Listings are already stamped immutably at List-click with
  `workspace_id`, `organization_id`, `dealership_id`, `actor_user_id`
  (migration 014). An observation does **not** carry a workspace; it inherits the
  matched row's stamp. The rooftop falls out of the match — no rooftop input needed.
- **Match scope (critical).** A user's FB account shows only *their own* listings,
  so the matcher restricts candidates to rows where `actor_user_id = observer` AND
  `workspace_id ∈ the user's accessible workspaces`. Uniqueness is
  `(workspace_id, actor_user_id, client_key)`, so two salespeople in one org can
  each hold a row for the same VIN — matching against the whole org workspace would
  mis-attribute one person's FB card to the other's row. Cross-actor / cross-rooftop
  fuzzy ambiguity → **no match** (never a wrong VIN, never a wrong rooftop).
- **Observation intake is multi-workspace fan-out.** Unlike `/listings/sync` and
  `/inventory/presence` (which now take a single `workspaceId` context), one FB read
  legitimately touches several workspaces. The endpoint matches each card, writes to
  the matched row's workspace, and **authorizes per row** — the observer must still
  have current access (seat/role) to that row's rooftop, so a removed salesperson's
  stale reads can't write. Reuse `backend/organization-authz.js`.
- **Account-level snapshot is per-(user, FB account), not per-rooftop.** The dashboard
  tiles/insights ("34 active", total clicks) aggregate the *entire FB account* and can
  span multiple rooftops *and* the personal↔org boundary. They must **never** be summed
  into a single rooftop's stats. Key `fb_account_snapshots` by `(user_id, fb_account_id)`
  and treat it as whole-account context only.
- **Per-rooftop / per-member stats come only from per-listing observations.** Aggregated
  by `dealership_id` + `actor_user_id`, these feed the org dashboard's Marketplace
  metrics (implementation.md §11: observed views, views/listing, **coverage**, last
  observed). Coverage = fraction of a rooftop's active listings with a *fresh*
  observation; unobserved shows **"Not available", never zero** (matches §11).
- **Capability gating (lease V2).** Reading is passive; *writing* observations and
  *enqueuing/executing* actions require a live seat/role at the matched rooftop. Cap
  `stats:own` sees a member's own numbers; `stats:team` (manager/owner) sees the rooftop.
- **Never claim a salesperson caused a dealership sale** (implementation.md §2). The
  `MARK_SOLD` task means "the *dealership* sold this car — take your stale FB listing
  down"; it routes through the existing `dealer_outcome` model, not a personal sale.

## 2. What we read (mapped to FB surfaces)

Facebook exposes two granularities on the Selling / Seller-dashboard pages. One read pass captures both (decision: store both from day one).

**Per-listing** (the "Your listings" cards) — matches to a VIN:
- title, price, status (`active` | `pending` | `sold` | `needs_attention`)
- listed date, "N clicks on listing", renewal hint ("Tip: Renew your listing")

**Account-level** (dashboard tiles + Marketplace insights) — no VIN, whole-account snapshot:
- tiles: Needs attention, Active & pending, Sold & out of stock, To renew, To delete & relist, Drafts
- insights (7/30d): Clicks, Saves, Shares, Followers · Seller rating · Chats to answer
- Marketplace profile name + active-listing count (used to confirm the connected account)

## 3. Read strategy — layers 1–3 only

A content script can only read what a tab has loaded. That yields three tiers:

1. **Passive, continuous (free).** Content scripts run in **background tabs** too.
   Whenever a Marketplace/Selling page is loaded in *any* tab, read the roster +
   dashboard and post. Covers the active salesperson with zero clicks.
2. **Account detection on any FB page.** From any `facebook.com` tab, read the
   logged-in profile to confirm *which* account is connected (and warn if the
   viewed account ≠ the account that owns the listings). Needs no Selling page.
3. **Activity-gated silent background-tab refresh.** When data is **stale** AND
   `chrome.idle` reports the user **active** AND an FB session is alive, open the
   Selling page in a **background tab**, read the real rendered DOM, post, close.
   Human cadence: at most ~2×/day, jittered, tied to activity — not a wall clock.
   The user clicks nothing; it renders the same page a human would.

**Manual "Refresh Facebook"** stays as a rare fallback (stale + "I need it now"),
not the workflow.

### Explicitly rejected (do not build)

- **#4 — silent fetch of FB's internal GraphQL/AJAX endpoints.** Brittle (FB
  rotates `doc_id`/`fb_dtsg`), the cleanest bot signal, and partnership-disqualifying.
- **#5 — export session cookies, scrape from the cloud 24/7.** Account-ban
  territory; the fatal signal (two-places-one-account provenance contradiction)
  isn't a frequency knob, and it undercuts the Phase-4 Meta partnership. True 24/7
  belongs to the official Messenger/WhatsApp/Page APIs, not scraping.

## 4. Freshness tiers

| Tier | Age | Behavior |
|---|---|---|
| Fresh | < 12h | FB stats shown plainly; tasks actionable |
| Stale | 12h–48h | Show "Facebook last synced Xh ago"; Layer-3 auto-refresh eligible |
| Very stale | > 48h | Mismatch tasks **downgrade to "verify"**, not assertions |

## 5. Data model (migration `009_marketplace_sync.sql`)

The FB listing mapping (`facebook_listing_id`, `facebook_listing_url`) and the
append-only-snapshot + latest-on-row pattern (`listing_view_snapshots` +
`views_count`/`views_observed_at`) **already exist** — mirror them.

**Add to `listings`** (latest-on-listing; what the task engine reads):
`fb_observed_status`, `fb_observed_price numeric(12,2)`, `fb_clicks int`,
`fb_renewal_eligible bool`, `fb_needs_attention bool`, `fb_observed_at timestamptz`.
No new tenancy columns needed here — the row already carries `workspace_id` /
`dealership_id` / `actor_user_id` (migration 014).

**`fb_observation_snapshots`** (append-only, one row per listing per check) —
mirrors `listing_view_snapshots`: `listing_id`, `fb_status`, `fb_price`,
`fb_clicks`, `renewal_eligible`, `needs_attention`, `observed_at`, `device_id`,
`roster_complete bool`. (Tenancy is joined from `listing_id`; don't denormalize a
workspace here — it can never disagree with the row's stamp.)

**`fb_account_snapshots`** (append-only, per check) — **per FB account, NOT per
rooftop** (see §1a): `user_id`, `fb_account_id`, the tile counts (`needs_attention`,
`active`, `sold`, `to_renew`, `to_relist`, `drafts`), insights (`clicks_7d`,
`saves_7d`, `shares_7d`, `followers`, `seller_rating`, `chats_to_answer`),
`observed_at`, `device_id`.

**`action_queue`**: `id`, `workspace_id`, `organization_id`, `dealership_id`,
`listing_id`, `actor_user_id`, `type` (`MARK_SOLD | SYNC_PRICE | RENEW | RELIST |
FIX`), `status` (`pending | waiting_for_fb | done | dismissed`), `created_by`
(`backend | app | user`), `payload jsonb`, `created_at`, `completed_at`. Scoped +
capability-gated like any tenant write.

All additive — no drops, old clients keep working. Depends on migration 014
(tenancy columns) already being applied.

## 6. Matcher + reconciler (pure, unit-tested modules)

**Matcher** — observed FB card → registry row, **scoped to `actor_user_id = observer`
within the user's accessible workspaces** (§1a):
1. **Strong key:** `facebook_listing_id` / `facebook_listing_url` captured at publish.
2. **Fallback:** normalized title (year+make+model) + price proximity.
3. **Ambiguous (≥2 fuzzy candidates) → no match.** Never mis-attribute a VIN or a rooftop.

**Reconciler** — compares the two truths → task list:

| Dealer truth | FB observation | Task | Gate |
|---|---|---|---|
| Sold / gone | Active (recent) | **MARK_SOLD** (urgent) | fresh obs only; else "verify" |
| Price changed | Different price | **SYNC_PRICE** (show both) | — |
| — | Renewal-eligible | **RENEW** | — |
| — | Needs-attention flag | **FIX** (opens listing) | — |
| Available | Missing from roster | **RELIST** | **`roster_complete` pass only** |
| Any | Not checked recently | (freshness banner + Layer-3 refresh) | staleness tier |

Two correctness rules that make "sync properly" true:
- **RELIST fires only off a complete roster read** — "not seen" ≠ "not there" on a
  partial/filtered view.
- **MARK_SOLD asserts only on a fresh observation** — a 3-day-old "active" is a
  lead to verify, not a fact.

## 7. Action queue — today inline, tomorrow app-driven

Every action is modeled as a queued task even when the extension executes it
inline today. This is the forward-compatible seam: the mobile app later just
writes `MARK_SOLD` with `created_by:'app'`, `status:'waiting_for_fb'`; the
extension drains it next time an FB session is available, deep-links to the exact
screen (Mark as sold / Edit / Renew from the `...` menu), and the salesperson
confirms. **Never auto-sends** — read-and-prepare, user clicks.

## 8. API surface

- `POST /api/marketplace/observations` — auth-gated, capped like `recordPresence`.
  Body: per-listing observations + account snapshot + `roster_complete` + `device_id`
  + `fb_account_id`. **Multi-workspace fan-out** (§1a): matches each card, writes to the
  matched row's workspace, and authorizes *per row* (observer must have current access to
  that rooftop). Returns the computed task list, scoped to what the caller may see.
- `GET /api/listings?workspaceId=` — extend to return `fb_observed_*` + freshness, within
  the selected workspace (reuses the existing workspace context resolver).
- `GET /api/marketplace/tasks?workspaceId=` (or fold into the listings read) — the task list.
- `action_queue`: `POST` to enqueue, `GET` pending, `PATCH` to mark done — the app/extension
  contract, scoped to the caller's workspace + rooftop capability.

## 9. Build order

1. **Migration `009` + pure matcher & reconciler** (fully unit-testable, no
   Facebook needed — the entire brain, provable green first). Includes the
   ambiguous-fuzzy→no-match and freshness/roster-gate cases.
2. **Observation intake route + `action_queue` table.**
3. **Extension observer** — reads roster + dashboard on any loaded Marketplace
   page (Layer 1), account detection (Layer 2), activity-gated background refresh
   (Layer 3). Isolate FB selectors in one module; log zero-cards-on-nonempty-page
   so a FB redesign surfaces in admin telemetry before users complain.
4. **Panel** — "What needs my attention today?": account header tiles, task list
   (each deep-linking its FB screen), freshness banner.

### Deferred (in order)
messages / inbox copilot → AI reply suggestions → auto-relisting → deeper
analytics → official Messenger/WhatsApp APIs → vehicle catalogs / Automotive
Inventory Ads → Meta Marketplace Partner Program (the only durable 24/7 unlock).

## 10. Policy guardrails (non-negotiable)

- Read-only observation; **never auto-send, never auto-publish.**
- No credential/cookie collection; no cloud-hosted personal sessions.
- No undocumented-endpoint fetching; observation only from pages the browser loaded.
- Every FB number shows its age; stale data is never presented as live.
- **Statistics never claim a salesperson caused a dealership sale** (implementation.md §2);
  a dealership sale routes through `dealer_outcome`, not personal sold attribution.
- All tenant reads/writes derive workspace + rooftop + capability **server-side** from the
  bearer session / lease V2; never trust workspace, rooftop, role, or actor sent by the client.
