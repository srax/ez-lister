-- 018_subscription_reconciliation_hardening: make Stripe repair concurrency-safe and
-- keep the reconciliation ledger bounded. Duplicate Stripe subscription IDs indicate
-- data corruption and must be resolved before this migration is deployed.

do $$
begin
  if exists (
    select 1
      from "subscription"
     where "stripeSubscriptionId" is not null
     group by "stripeSubscriptionId"
    having count(*) > 1
  ) then
    raise exception 'duplicate subscription.stripeSubscriptionId rows must be reconciled before migration 018';
  end if;
end $$;

create unique index if not exists "subscription_stripeSubscriptionId_unique_idx"
  on "subscription" ("stripeSubscriptionId")
  where "stripeSubscriptionId" is not null;

create index if not exists subscription_reconciliation_runs_created_idx
  on subscription_reconciliation_runs (created_at);
