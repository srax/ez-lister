-- 010_better_auth_organization: schema declared by better-auth 1.6.x's organization
-- plugin, plus the Stripe plugin's organization customer field. Better Auth owns these
-- records at runtime. Names follow its default Postgres adapter conventions.

create table if not exists "organization" (
  "id"               text primary key,
  "name"             text not null,
  "slug"             text not null unique,
  "logo"             text,
  "createdAt"        timestamptz not null default current_timestamp,
  "metadata"         text,
  "stripeCustomerId" text
);

create table if not exists "member" (
  "id"             text primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "userId"         text not null references "user" ("id") on delete cascade,
  "role"           text not null default 'member',
  "createdAt"      timestamptz not null default current_timestamp,
  unique ("organizationId", "userId")
);

create table if not exists "invitation" (
  "id"             text primary key,
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "email"          text not null,
  "role"           text,
  "status"         text not null default 'pending',
  "expiresAt"      timestamptz not null,
  "createdAt"      timestamptz not null default current_timestamp,
  "inviterId"      text not null references "user" ("id") on delete cascade
);

alter table "session" add column if not exists "activeOrganizationId" text;
alter table "organization" add column if not exists "stripeCustomerId" text;

create index if not exists "organization_slug_idx" on "organization" ("slug");
create index if not exists "member_organizationId_idx" on "member" ("organizationId");
create index if not exists "member_userId_idx" on "member" ("userId");
create index if not exists "invitation_organizationId_idx" on "invitation" ("organizationId");
create index if not exists "invitation_email_idx" on "invitation" ("email");
