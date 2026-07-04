-- 004: @better-auth/stripe schema — the plugin-owned `subscription` table + user.stripeCustomerId.
-- Columns mirror the plugin's declared schema exactly (Better Auth conventions: quoted
-- camelCase identifiers, text ids, timestamptz dates, integer counts) so the plugin's adapter
-- reads/writes line up. Applied on boot by db.js and recorded in schema_migrations.

create table if not exists "subscription" (
  "id"                   text primary key,
  "plan"                 text not null,
  "referenceId"          text not null,
  "stripeCustomerId"     text,
  "stripeSubscriptionId" text,
  "status"               text default 'incomplete',
  "periodStart"          timestamptz,
  "periodEnd"            timestamptz,
  "trialStart"           timestamptz,
  "trialEnd"             timestamptz,
  "cancelAtPeriodEnd"    boolean default false,
  "cancelAt"             timestamptz,
  "canceledAt"           timestamptz,
  "endedAt"              timestamptz,
  "seats"                integer,
  "billingInterval"      text,
  "stripeScheduleId"     text
);

create index if not exists "subscription_referenceId_idx"         on "subscription" ("referenceId");
create index if not exists "subscription_stripeSubscriptionId_idx" on "subscription" ("stripeSubscriptionId");
create index if not exists "subscription_stripeCustomerId_idx"     on "subscription" ("stripeCustomerId");

-- Link a Better Auth user to their Stripe customer (createCustomerOnSignUp writes this).
alter table "user" add column if not exists "stripeCustomerId" text;
