-- 014_workspace_attribution: additive tenancy fields. Legacy owner/user columns remain
-- available until the minimum extension version advances.

alter table listings add column if not exists workspace_id text references workspaces (id);
alter table listings add column if not exists organization_id text references "organization" (id);
alter table listings add column if not exists actor_user_id text;

update listings l
set workspace_id = w.id,
    actor_user_id = coalesce(l.actor_user_id, l.owner_id)
from workspaces w
where w.type = 'personal' and w.user_id = l.owner_id and l.workspace_id is null;

create index if not exists listings_workspace_status_idx
  on listings (workspace_id, status);
create index if not exists listings_organization_dealer_idx
  on listings (organization_id, dealership_id);
create unique index if not exists listings_workspace_actor_client_key_idx
  on listings (workspace_id, actor_user_id, client_key)
  where workspace_id is not null and actor_user_id is not null;

-- The workspace key supersedes the V1 owner key. Dropping the old uniqueness allows one
-- salesperson to retain separate personal and organization history for the same vehicle.
alter table listings drop constraint if exists listings_owner_id_client_key_key;
create index if not exists listings_owner_client_key_idx on listings (owner_id, client_key);

alter table usage_events add column if not exists workspace_id text references workspaces (id);
alter table usage_events add column if not exists organization_id text references "organization" (id);
alter table usage_events add column if not exists actor_user_id text;

update usage_events e
set workspace_id = w.id,
    actor_user_id = coalesce(e.actor_user_id, e.user_id)
from workspaces w
where w.type = 'personal' and w.user_id = e.user_id and e.workspace_id is null;

create index if not exists usage_events_workspace_time_idx
  on usage_events (workspace_id, occurred_at);

alter table comp_grants add column if not exists workspace_id text references workspaces (id);
update comp_grants g
set workspace_id = w.id
from workspaces w
where w.type = 'personal' and w.user_id = g.user_id and g.workspace_id is null;
