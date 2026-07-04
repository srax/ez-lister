-- 001_init: Carxpert-owned domain schema (Postgres).
--
-- Better Auth OWNS user/session/account/verification (+ subscription from the Stripe
-- plugin) and generates them via its CLI — those are added in a later, generated
-- migration. Nothing here FKs to `user`; owner_id / user_id are plain text (Better Auth
-- uses TEXT ids) so this migration is independent of auth landing.

-- ---- dealerships (platform adapter x per-dealership config) ----
create table dealerships (
  id        text primary key,
  name      text not null,
  platform  text not null,                                 -- 'dealeron' | 'cdk' | 'dealerdotcom' | ...
  status    text not null default 'supported',             -- 'supported' | 'detected' | 'unsupported'
  timezone  text not null default 'America/New_York',
  config    jsonb not null default '{}'                     -- inventoryUrls, sitemapUrl, photo pattern, location, ...
);

create table dealership_aliases (                           -- exact-match only; no fuzzy/suffix
  domain        text primary key,                           -- lowercased host, e.g. 'www.alexandriatoyota.com'
  dealership_id text not null references dealerships(id)
);

create table user_dealerships (                             -- one per user in v1
  user_id       text primary key,
  dealership_id text not null references dealerships(id),
  linked_at     timestamptz not null default now()
);

create table dealer_requests (
  id                text primary key,
  user_id           text not null,
  raw_input         text not null,
  normalized_domain text,
  detected_platform text,
  fingerprints      jsonb,
  created_at        timestamptz not null default now()
);

-- ---- listings synced from the extension ----
create table listings (
  id                     text primary key,
  owner_id               text not null,
  dealership_id          text,
  client_key             text not null,                     -- VIN(upper) -> stock -> sourceUrl
  vin                    text,                              -- checksum-validated or null
  stock                  text,
  title                  text,
  year                   int,
  make                   text,
  model                  text,
  price                  numeric(12,2),
  platform               text not null default 'fb',
  status                 text not null default 'listed',    -- 'listed' | 'sold' | 'removed'
  sold_source            text,                              -- 'manual' | 'scan' (manual always wins)
  listed_at              timestamptz,
  sold_at                timestamptz,
  sold_price             numeric(12,2),
  source_url             text,
  facebook_listing_id    text,
  facebook_listing_url   text,
  facebook_published_at  timestamptz,
  views_count            int,
  views_observed_at      timestamptz,
  last_seen_in_inventory_at timestamptz,
  first_missed_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (owner_id, client_key)
);
create index listings_owner_status_idx on listings (owner_id, status);
create index listings_owner_listed_idx on listings (owner_id, listed_at);
create index listings_dealership_status_idx on listings (dealership_id, status);

create table listing_view_snapshots (                       -- append-only view history
  listing_id  text not null references listings(id),
  views_count int not null,
  observed_at timestamptz not null,
  primary key (listing_id, observed_at)
);

-- ---- usage / eval telemetry (retained 90 days by the worker cleanup) ----
create table usage_events (
  id          text primary key,                             -- client uuid = idempotency key
  user_id     text not null,
  type        text not null,                                -- list_clicked | fill_completed | publish_detected | marked_sold | marked_sold_undo | views_observed
  client_key  text,
  data        jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index usage_events_user_time_idx on usage_events (user_id, occurred_at);
create index usage_events_type_time_idx on usage_events (type, occurred_at);

-- ---- sold-scan bookkeeping (counts/timestamps only; never the full dealer inventory) ----
create table dealer_inventory_scans (
  id            text primary key,
  dealership_id text not null,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  ok            boolean,
  vin_count     int,
  source        text,                                       -- 'sitemap' | 'srp'
  error         text
);
create index dealer_inventory_scans_dealer_time_idx on dealer_inventory_scans (dealership_id, started_at);

-- ---- extension auth handoff (one-time codes; 60s TTL, single-use) ----
create table extension_auth_codes (
  code       text primary key,
  user_id    text not null,
  expires_at timestamptz not null,
  used       boolean not null default false
);

-- ---- entitlement without Stripe (friends / testing) ----
create table comp_grants (
  user_id    text primary key,
  expires_at timestamptz,
  note       text,
  created_at timestamptz not null default now()
);

-- ---- per-user daily AI usage counters ----
create table ai_usage (
  user_id         text not null,
  day             date not null,
  describe_count  int not null default 0,
  translate_count int not null default 0,
  primary key (user_id, day)
);
