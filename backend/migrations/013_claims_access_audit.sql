-- 013_claims_access_audit: dealership claims, employee access, inbox, and audit history.

create table if not exists dealership_claims (
  id                     text primary key,
  claim_group_id         text not null,
  user_id                text not null references "user" (id) on delete cascade,
  dealership_id          text not null references dealerships (id),
  organization_id        text references "organization" (id) on delete set null,
  organization_name      text,
  status                 text not null default 'pending'
                         check (status in ('pending', 'evidence_requested', 'approved', 'checkout_pending', 'active', 'rejected', 'expired', 'conflict', 'disputed', 'suspended', 'transferred')),
  attested_at            timestamptz not null,
  reservation_expires_at timestamptz,
  reviewed_by            text,
  reviewed_at            timestamptz,
  review_reason          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists dealership_claims_review_idx
  on dealership_claims (status, created_at);
create index if not exists dealership_claims_user_idx
  on dealership_claims (user_id, created_at desc);
create unique index if not exists dealership_claims_user_open_idx
  on dealership_claims (user_id, dealership_id)
  where status in ('pending', 'evidence_requested');
create unique index if not exists dealership_claims_active_reservation_idx
  on dealership_claims (dealership_id)
  where status in ('approved', 'checkout_pending', 'active');

create table if not exists claim_evidence (
  id          text primary key,
  claim_id    text not null references dealership_claims (id) on delete cascade,
  type        text not null,
  summary     text,
  recorded_by text,
  created_at  timestamptz not null default now()
);

create table if not exists organization_access_requests (
  id              text primary key,
  organization_id text not null references "organization" (id) on delete cascade,
  dealership_id   text not null references dealerships (id),
  user_id         text not null references "user" (id) on delete cascade,
  email           text not null,
  requested_role  text not null default 'salesperson'
                  check (requested_role in ('manager', 'salesperson')),
  status          text not null default 'pending'
                  check (status in ('pending', 'approved_awaiting_capacity', 'approved', 'rejected', 'canceled')),
  reviewed_by     text references "user" (id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists organization_access_requests_open_idx
  on organization_access_requests (organization_id, dealership_id, user_id)
  where status in ('pending', 'approved_awaiting_capacity');

create table if not exists organization_audit_events (
  id              text primary key,
  organization_id text references "organization" (id) on delete set null,
  dealership_id   text references dealerships (id),
  actor_user_id   text,
  action          text not null,
  target_type     text,
  target_id       text,
  reason          text,
  data            jsonb,
  occurred_at     timestamptz not null default now()
);
create index if not exists organization_audit_events_org_time_idx
  on organization_audit_events (organization_id, occurred_at desc);

create table if not exists organization_notifications (
  id              text primary key,
  user_id         text not null references "user" (id) on delete cascade,
  organization_id text references "organization" (id) on delete cascade,
  type            text not null,
  data            jsonb,
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index if not exists organization_notifications_user_unread_idx
  on organization_notifications (user_id, created_at desc) where read_at is null;
