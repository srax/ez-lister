-- Per-platform listing presence (multi-marketplace: fb, craigslist, offerup, …).
-- One canonical car row stays in `listings`; each marketplace presence is a child row, so a
-- car on Facebook AND Craigslist is finally representable server-side (it was one row with a
-- single platform column before — cross-device restore collapsed multi-platform cars to fb).
-- Purely additive: no column drops, no destructive updates; old clients keep working.

create table if not exists listing_platforms (
  listing_id   text not null references listings(id) on delete cascade,
  platform     text not null,                     -- 'fb' | 'craigslist' | 'offerup' | ...
  status       text not null default 'listed',   -- 'listed' | 'removed'
  listed_at    timestamptz,
  listing_url  text,                              -- "View listing" target (FB item / CL manage)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (listing_id, platform)
);

create index if not exists listing_platforms_platform_idx on listing_platforms (platform);

-- Which marketplace a sale was credited to (attribution — the car itself sells once).
alter table listings add column if not exists sold_platform text;

-- Backfill: every existing car is represented by its legacy single-platform column, so all
-- pre-multi-platform data (Facebook history) survives unchanged from the first boot.
insert into listing_platforms (listing_id, platform, status, listed_at)
select id,
       coalesce(platform, 'fb'),
       case when status = 'removed' then 'removed' else 'listed' end,
       listed_at
from listings
on conflict (listing_id, platform) do nothing;
