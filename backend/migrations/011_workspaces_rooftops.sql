-- 011_workspaces_rooftops: tenant boundary and organization-to-rooftop ownership.

create table if not exists workspaces (
  id              text primary key,
  type            text not null check (type in ('personal', 'organization')),
  user_id         text references "user" (id) on delete cascade,
  organization_id text references "organization" (id) on delete cascade,
  status          text not null default 'active'
                  check (status in ('provisional', 'active', 'past_due', 'suspended', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (
    (type = 'personal' and user_id is not null and organization_id is null)
    or
    (type = 'organization' and user_id is null and organization_id is not null)
  )
);

create unique index if not exists workspaces_personal_user_idx
  on workspaces (user_id) where type = 'personal';
create unique index if not exists workspaces_organization_idx
  on workspaces (organization_id) where type = 'organization';

insert into workspaces (id, type, user_id, status)
select 'personal:' || id, 'personal', id, 'active'
from "user"
on conflict do nothing;

create table if not exists organization_profiles (
  organization_id         text primary key references "organization" (id) on delete cascade,
  primary_owner_member_id text,
  status                  text not null default 'provisional'
                          check (status in ('provisional', 'active', 'past_due', 'suspended', 'archived')),
  grace_ends_at           timestamptz,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists organization_rooftops (
  organization_id       text not null references "organization" (id) on delete cascade,
  dealership_id         text not null references dealerships (id),
  status                text not null default 'reserved'
                        check (status in ('reserved', 'active', 'past_due', 'suspended', 'pending_removal', 'archived')),
  included_seats        integer not null default 10 check (included_seats >= 0),
  extra_seats           integer not null default 0 check (extra_seats >= 0),
  reservation_expires_at timestamptz,
  activated_at          timestamptz,
  removal_effective_at  timestamptz,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, dealership_id)
);

create unique index if not exists organization_rooftops_one_owner_idx
  on organization_rooftops (dealership_id)
  where status in ('reserved', 'active', 'past_due', 'suspended', 'pending_removal');
create index if not exists organization_rooftops_org_status_idx
  on organization_rooftops (organization_id, status);
