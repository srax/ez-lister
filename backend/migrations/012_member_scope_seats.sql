-- 012_member_scope_seats: user-facing roles, rooftop scope, and listing capacity.

create table if not exists organization_member_profiles (
  member_id        text primary key references "member" (id) on delete cascade,
  organization_id text not null references "organization" (id) on delete cascade,
  user_id          text not null references "user" (id) on delete cascade,
  role             text not null check (role in ('owner', 'manager', 'salesperson')),
  all_rooftops     boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  removed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id),
  check (role = 'manager' or all_rooftops = false)
);

create table if not exists member_rooftop_access (
  member_id        text not null references "member" (id) on delete cascade,
  organization_id text not null references "organization" (id) on delete cascade,
  dealership_id   text not null references dealerships (id),
  role             text not null check (role in ('manager', 'salesperson')),
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  primary key (member_id, dealership_id)
);
create index if not exists member_rooftop_access_org_dealer_idx
  on member_rooftop_access (organization_id, dealership_id) where revoked_at is null;

create table if not exists seat_assignments (
  id              text primary key,
  organization_id text not null references "organization" (id) on delete cascade,
  dealership_id   text not null references dealerships (id),
  member_id       text not null references "member" (id) on delete cascade,
  assigned_by     text references "user" (id),
  assigned_at     timestamptz not null default now(),
  released_by     text references "user" (id),
  released_at     timestamptz
);
create unique index if not exists seat_assignments_active_member_idx
  on seat_assignments (organization_id, dealership_id, member_id)
  where released_at is null;
create index if not exists seat_assignments_capacity_idx
  on seat_assignments (organization_id, dealership_id) where released_at is null;

create table if not exists organization_invitation_scopes (
  invitation_id   text primary key references "invitation" (id) on delete cascade,
  token_hash      text not null unique,
  organization_id text not null references "organization" (id) on delete cascade,
  requested_role  text not null check (requested_role in ('manager', 'salesperson')),
  all_rooftops    boolean not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists organization_invitation_rooftops (
  invitation_id text not null references "invitation" (id) on delete cascade,
  dealership_id text not null references dealerships (id),
  role           text not null check (role in ('manager', 'salesperson')),
  reserve_seat   boolean not null default false,
  primary key (invitation_id, dealership_id)
);

create table if not exists seat_reservations (
  id              text primary key,
  organization_id text not null references "organization" (id) on delete cascade,
  dealership_id   text not null references dealerships (id),
  target_type     text not null check (target_type in ('invitation', 'access_request')),
  target_id       text not null,
  expires_at      timestamptz not null,
  released_at     timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists seat_reservations_active_target_idx
  on seat_reservations (target_type, target_id, dealership_id)
  where released_at is null;
create index if not exists seat_reservations_capacity_idx
  on seat_reservations (organization_id, dealership_id, expires_at)
  where released_at is null;
