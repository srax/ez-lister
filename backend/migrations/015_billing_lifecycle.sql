-- 015_billing_lifecycle: Stripe allocation/reconciliation records without card data.

create table if not exists organization_billing_items (
  organization_id         text primary key references "organization" (id) on delete cascade,
  stripe_subscription_id  text,
  rooftop_item_id         text,
  rooftop_quantity        integer not null default 0 check (rooftop_quantity >= 0),
  extra_seat_item_id      text,
  extra_seat_quantity     integer not null default 0 check (extra_seat_quantity >= 0),
  synced_at               timestamptz,
  updated_at              timestamptz not null default now()
);

alter table organization_profiles add column if not exists suspended_at timestamptz;
alter table organization_rooftops add column if not exists requested_extra_seats integer
  check (requested_extra_seats is null or requested_extra_seats >= 0);
alter table organization_rooftops add column if not exists capacity_change_effective_at timestamptz;

create table if not exists workspace_comp_grants (
  id           text primary key,
  workspace_id text not null references workspaces (id) on delete cascade,
  expires_at   timestamptz,
  reason       text not null,
  created_by   text,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index if not exists workspace_comp_grants_live_idx
  on workspace_comp_grants (workspace_id, expires_at) where revoked_at is null;

create table if not exists subscription_reconciliation_runs (
  id              text primary key,
  reference_id    text,
  stripe_customer_id text,
  result          text not null,
  details         jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists personal_rooftop_changes (
  id                text primary key,
  user_id           text not null references "user" (id) on delete cascade,
  from_dealership_id text references dealerships (id),
  to_dealership_id   text not null references dealerships (id),
  changed_at         timestamptz not null default now(),
  approved_by        text,
  reason             text
);
create index if not exists personal_rooftop_changes_user_time_idx
  on personal_rooftop_changes (user_id, changed_at desc);
