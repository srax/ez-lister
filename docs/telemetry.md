# Telemetry & analytics — what exists, what's missing, where it goes

How Carxpert measures itself today, the questions the current schema can and cannot
answer, and the staged plan for when more dealerships and salespeople onboard.
Companion to `docs/store-listing.md` (privacy disclosures) and `npm run ops`.

## Principles (the floor we never dig below)

- **Product events only.** We record what the user did with Carxpert (fill and publish)
  plus scanner-confirmed inventory outcomes — never browsing history, page content beyond the selected vehicle, or
  anything from Facebook other than "our fill completed / a publish happened".
- **Events are disposable, listings are business records.** `usage_events` is pruned at
  90 days (wired into the hourly worker via `pruneUsageEvents`); `listings` rows preserve
  listing history. Scanner-confirmed sales are dealership outcomes, not salesperson credit.
- **Idempotent by construction.** Every event carries a client-generated UUID
  (`usage_events.id`), so offline retries and double-syncs can never double-count.
- **Per-user scoping.** All analytics join through `owner_id`/`user_id`; nothing is
  shared between salespeople except dealership-level rollups we compute server-side.

## Inventory: what exists today

### Tables (backend/migrations/001_init.sql)

| Table | What it captures | Analytical value |
|---|---|---|
| `usage_events` | One row per product action: `id` (uuid, dedupe), `user_id`, `type`, `client_key`, `data` jsonb, `occurred_at` (client), `received_at` (server) | The funnel + eval raw material. 90-day retention. |
| `listings` | Full listing lifecycle per (workspace, actor, vehicle): status listed/sold/removed, `sold_source` manual/scan, `listed_at`/`sold_at`, inventory evidence, marketplace URLs, and `views_count` | Days on market, active inventory value, and dealership outcomes. Permanent. |
| `listing_view_snapshots` | Append-only (listing, views, observed_at) history | **Dormant** — waiting on views/leads sync (V1.1+). |
| `dealer_inventory_scans` | One row per sold-scan cycle: ok, vin_count, source, error | Scan health/SLO; never stores dealer inventory itself. |
| `ai_usage` | Per-user per-day describe/translate counters | AI adoption + cost ceiling enforcement. |
| `user_dealerships`, `comp_grants`, `subscription` (Better Auth), `user` (Better Auth) | Who's linked, who's comped, who pays | Joins for activation/conversion. |

### Core listing-lifecycle events

The current extension emits fill/publish events; the backend worker records dealership outcomes.
Manual-sale types remain accepted only for backward compatibility:

| Type | Emitted from | Payload | Status |
|---|---|---|---|
| `fill_completed` | facebookContent.js after a form fill | `data.fields = [{name, ok, msg}]` per field | ✅ live — powers `/api/admin/fill-accuracy` |
| `publish_detected` | facebookContent.js on real publish (URL transition) | `clientKey` | ✅ live |
| `marked_sold` | older sidepanel versions | `data.soldPrice` | Legacy input accepted; not emitted or counted by the current UI |
| `marked_sold_undo` | older sidepanel versions | — | Legacy input accepted; not emitted by the current UI |
| `scan_marked_sold` | backend inventory worker | VIN + dealership ID | Live — scanner-confirmed dealership outcome |
| `scan_revived` | backend inventory worker | VIN + dealership ID | Live — correction when inventory reappears |
| `list_clicked` | **nowhere** | — | ❌ declared, never emitted |
| `views_observed` | **nowhere** | — | ❌ waiting on views sync |

Flow: content script/panel → `EZLIST_ENQUEUE_EVENT` → `ezlistEventQueue` (bounded 500,
survives offline) → debounced `syncNow()` + 30-min alarm → `POST /api/listings/sync` →
server dedupes by uuid.

### Query surfaces today

- `npm run ops` → `GET /api/admin/overview` — users/links/comp, subs by status,
  listings by status, 7-day event volume, last scan, AI today.
- `GET /api/admin/fill-accuracy?days=N` — per-field ok-rate. This is the **eval loop**:
  every real listing is a test case; a field's ok-rate dropping means Facebook changed
  the form before any user complains.
- `GET /api/admin/scans` — scan history.

## What we can already answer (query cookbook)

```sql
-- Time-to-first-publish per user (activation)
select u.email, min(l.listed_at) - u."createdAt" as time_to_first_listing
from "user" u join listings l on l.owner_id = u.id group by u.email, u."createdAt";

-- Listings per active user per week
select date_trunc('week', listed_at) wk, owner_id, count(*) 
from listings group by 1,2 order by 1;

-- Dealership outcomes + average days on market (never salesperson attribution)
select count(distinct coalesce(vin,client_key)), avg(sold_at - listed_at) avg_days
from listings where status='sold' and sold_source='scan';

-- Publish-per-fill ratio (funnel health: fills that turned into real listings)
select (select count(*) from usage_events where type='publish_detected' and occurred_at > now()-interval '30 days')::float
     / nullif((select count(*) from usage_events where type='fill_completed' and occurred_at > now()-interval '30 days'),0);

-- Scan correction signal: a scanner-sold VIN later reappeared in inventory
select count(*) from usage_events where type='scan_revived';
```

## The gaps (honest list)

1. **Funnel is blind before the fill.** No `list_clicked` (declared but never emitted),
   no `fill_started`/`fill_failed` — an abandoned or crashed fill is invisible; we only
   see successes. At one dealer we hear about failures in person; at ten we won't.
2. **Onboarding funnel is invisible.** Sign-in → dealer-linked → checkout-opened →
   subscribed exists only as *end states* (rows in `user_dealerships`/`subscription`),
   not as timed events. We can't measure where prospects stall or how long the gate takes.
3. **Events don't carry dealership or client version.** `usage_events` has neither;
   dealership is joinable via `user_dealerships` but that join is *mutable* — a relink
   rewrites history. Version matters the day two extension versions are in the wild.
4. **AI has usage counts but no outcome.** We know describe was called; we don't know
   whether the draft was kept, edited, or discarded — the only signal that the prompt
   is any good.
5. **No client error telemetry.** Content-script/worker exceptions die silently in the
   user's console.
6. **No latency.** Fill duration, photo-fetch time, time-from-click-to-publishable —
   all unmeasured; "it feels slow" will be undebuggable at distance.
7. **90-day prune with no rollup** — fine now, but long-term trends (season, cohort)
   evaporate. Listings survive, event-level behavior doesn't.
8. **Subscription history.** Better Auth's `subscription` table holds *current* state;
   churn analysis needs status-change history (webhooks already deliver it — we just
   don't record it).
9. **Views/leads** — `listing_view_snapshots` + `views_observed` are built and waiting;
   the FB-side collection isn't (known V1.1+ roadmap item).

## Improvement plan (staged with onboarding scale)

### Phase 1 — more events, zero migrations (ship with V1.1)

All additive `usage_events` types + jsonb payload conventions; the pipe, dedupe, and
retention already handle them.

- Emit `list_clicked` from dealerContent (the type already exists).
- `fill_started` and `fill_failed { step, field, reason }` from facebookContent —
  makes the fill funnel and its failure modes measurable.
- Add `durationMs` to `fill_completed.data`.
- Onboarding beats from background.js: `signin_completed`,
  `dealer_linked { method: 'auto' | 'manual' }`, `checkout_opened`.
- AI outcome: `ai_generated { kind, chars }` and enrich `fill_completed.data` with
  `descriptionSource: 'ai' | 'ai_edited' | 'manual'` (panel knows).
- **Stamp every event at enqueue** (in background `enqueueEvent`) with
  `data._v` (extension version) and `data._dlr` (linked dealership id) — denormalized
  at write time so later relinks can't rewrite history.
- `client_error { context, message }` — try/catch at the three entry points, heavily
  truncated, never page content.

### Phase 2 — schema, one migration (when ~3+ dealerships)

```sql
-- 006_telemetry.sql (sketch)
alter table usage_events add column if not exists dealership_id text;
alter table usage_events add column if not exists client_version text;
create index if not exists usage_events_dealer_time_idx on usage_events (dealership_id, occurred_at);

create table if not exists usage_daily (          -- survives the 90-day raw prune
  day           date not null,
  user_id       text not null,
  dealership_id text,
  type          text not null,
  n             int  not null,
  primary key (day, user_id, type)
);
-- worker: upsert yesterday's counts before pruning raw events

create table if not exists billing_events (        -- churn history from Stripe webhooks
  id text primary key, user_id text, type text, status text, occurred_at timestamptz
);
```

Promote `_v`/`_dlr` out of jsonb into the real columns at that point; rollup keeps
per-day trends forever while raw events stay 90-day.

### Phase 3 — surfaces (same release or next)

- `GET /api/admin/funnel?days=30` — per-dealership: signups → linked → subscribed →
  first fill → first publish, with median step times.
- `GET /api/admin/dealers/:id/summary` — the "how is this dealership doing" call:
  active salespeople, listings/wk, publish-per-fill, days-to-sale, scan health.
- `npm run ops` grows a per-dealership section + week-over-week deltas.
- Alert thresholds (start as a checklist, automate later — a worker check that POSTs
  to an email/webhook when tripped):
  - scan `ok=false` twice consecutively for any dealership
  - any fill field ok-rate drops >20 points week-over-week (Facebook changed the form)
  - publish-per-fill under 0.5 for a week (fills happening, publishes not)
  - `client_error` volume spike per version (bad release)

### Phase 4 — product analytics at real scale

Views/leads sync (finally uses `listing_view_snapshots`), retention cohorts by
dealership onboarding month, revenue joins over `billing_events`, and — only if
volume ever warrants it — export to a real warehouse. Postgres + these tables will
comfortably carry hundreds of salespeople; don't add infrastructure before then.

## Pilot KPIs (what to watch weekly, all answerable today or after Phase 1)

| KPI | Source | Healthy |
|---|---|---|
| Activation: signup → first publish | `user` + `listings` | < 1 day |
| Weekly active listers | `usage_events` publish_detected | ≥ ⅔ of subscribed |
| Listings / lister / week | `listings` | dealer-dependent; watch trend |
| Publish-per-fill | events ratio | > 0.7 |
| Fill field ok-rate | `/api/admin/fill-accuracy` | > 0.9 per field (watch colours/Mileage) |
| Days-to-sale | `listings` sold | trend only |
| Scan health | `/api/admin/scans` | 24/24 ok daily |
| AI adoption | `ai_usage` | trend only |
