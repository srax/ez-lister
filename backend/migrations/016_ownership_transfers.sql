-- 016_ownership_transfers: two-party, expiring organization-owner handoff.

create table if not exists organization_ownership_transfers (
  id                 text primary key,
  organization_id    text not null references "organization" (id) on delete cascade,
  from_member_id     text not null references "member" (id) on delete cascade,
  to_member_id       text not null references "member" (id) on delete cascade,
  token_hash         text not null unique,
  status             text not null default 'pending'
                     check (status in ('pending', 'accepted', 'canceled', 'expired')),
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  accepted_at        timestamptz,
  canceled_at        timestamptz,
  check (from_member_id <> to_member_id)
);

create unique index if not exists organization_ownership_transfers_pending_idx
  on organization_ownership_transfers (organization_id) where status='pending';
create index if not exists organization_ownership_transfers_target_idx
  on organization_ownership_transfers (to_member_id, status, expires_at);
