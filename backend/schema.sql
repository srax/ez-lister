-- Carxpert app-domain schema (Postgres). Individual-pays SaaS, fully paywalled.
--
-- AUTH & BILLING TABLES ARE NOT DEFINED HERE. Better Auth owns them and generates
-- them via `npx @better-auth/cli generate`:
--   • user, session, account, verification            (core)
--   • subscription                                     (@better-auth/stripe plugin)
--   • organization, member, invitation                 (organization plugin — our
--                                                        "dealership" hierarchy, added later)
--
-- This file defines only the domain data the app owns: listings synced from the
-- extension. Better Auth uses TEXT ids, so FKs are text.

create table listings (
  id             text primary key,                -- app-generated (nanoid/uuid as text)
  owner_id       text not null,                    -- Better Auth user.id
  dealership_id  text,                             -- Better Auth organization.id (null now)
  client_key     text not null,                    -- extension key (VIN→stock→url) — idempotency
  vin            text,
  stock          text,
  title          text,
  year           int,
  make           text,
  model          text,
  price          numeric(12,2),
  platform       text not null default 'fb',
  status         text not null default 'active',   -- 'active' | 'sold' | 'removed'
  listed_at      timestamptz,
  sold_at        timestamptz,
  sold_price     numeric(12,2),
  source_url     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, client_key)                     -- idempotent upsert per user
);
create index on listings (owner_id, status);
create index on listings (owner_id, listed_at);

-- ENTITLEMENT (no free tier → no active subscription = no access):
--   entitled(user) = exists subscription row for the user (or, later, their organization)
--   with status in ('active','trialing') and periodEnd in the future.
-- Gate /api/ai/* and premium stats on entitled(); gate listings-sync on a valid session.
