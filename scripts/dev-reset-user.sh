#!/usr/bin/env bash
# dev-reset-user.sh — DEV/STAGING ONLY: erase a user completely so the same Gmail account can
# sign up fresh (re-test onboarding, dealership connect, checkout).
#
#   ./scripts/dev-reset-user.sh <email> [--yes] [--drop-dealership]
#
#   <email>             the Google account to erase (case-insensitive)
#   --yes               skip the interactive confirmation
#   --drop-dealership   also delete the dealership the user was linked to (only when no other
#                       user or listing still references it) — for re-testing auto-onboarding
#
# Connection: uses $STAGING_DATABASE_URL if set, otherwise fetches DATABASE_PUBLIC_URL from the
# Railway *staging* environment (the environment name is HARDCODED here — this script can never
# point itself at production). All deletes run in ONE transaction with ON_ERROR_STOP: any error
# rolls back everything, so a partial delete can't be left behind.
#
# What it deletes (children first; session/account/listing_platforms go via FK cascade):
#   listing_view_snapshots → listings (+listing_platforms) → usage_events, dealer_requests,
#   extension_auth_codes, comp_grants, ai_usage, user_dealerships → subscription →
#   verification(email) → "user" (cascades session, account)
# NOT deleted: the Stripe-sandbox customer/subscription on Stripe's side (test mode; a fresh
# checkout just creates a new customer) and — unless --drop-dealership — the dealerships row.

set -euo pipefail

EMAIL="${1:-}"
YES=0
DROP_DEALER=0
for arg in "${@:2}"; do
  case "$arg" in
    --yes) YES=1 ;;
    --drop-dealership) DROP_DEALER=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$EMAIL" || "$EMAIL" != *@* ]]; then
  echo "usage: $0 <email> [--yes] [--drop-dealership]" >&2
  exit 2
fi

# ---- resolve the staging database URL ----
DB_URL="${STAGING_DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  command -v railway >/dev/null || { echo "railway CLI not found and STAGING_DATABASE_URL not set" >&2; exit 1; }
  # Environment pinned to staging — never accepts an override.
  DB_URL="$(railway variables --service Postgres --environment staging --kv 2>/dev/null \
    | grep '^DATABASE_PUBLIC_URL=' | head -1 | cut -d= -f2-)"
fi
[[ -n "$DB_URL" ]] || { echo "could not resolve the staging DATABASE_PUBLIC_URL" >&2; exit 1; }
if [[ "$DB_URL" == *railway.internal* ]]; then
  echo "refusing: got an internal-only DB host (unreachable from here)" >&2; exit 1
fi

DB_HOST="$(sed -E 's#^[a-z]+://[^@]+@([^:/]+).*#\1#' <<<"$DB_URL")"
echo "target database host: $DB_HOST (Railway environment: staging)"

# ---- pre-delete report ----
REPORT="$(psql "$DB_URL" -X -A -t -v ON_ERROR_STOP=1 -v email="$EMAIL" <<'SQL'
select coalesce(
  (select 'user id: ' || u."id"
     || E'\n  sessions: '        || (select count(*) from "session" s where s."userId" = u."id")
     || E'\n  listings: '        || (select count(*) from listings l where l.owner_id = u."id")
     || E'\n  usage events: '    || (select count(*) from usage_events e where e.user_id = u."id")
     || E'\n  subscriptions: '   || (select count(*) from "subscription" x where x."referenceId" = u."id")
     || E'\n  dealership link: ' || coalesce((select d.name || ' (' || d.id || ')'
                                       from user_dealerships ud join dealerships d on d.id = ud.dealership_id
                                       where ud.user_id = u."id"), 'none')
   from "user" u where lower(u."email") = lower(:'email')),
  'NOT_FOUND')
SQL
)"

if [[ "$REPORT" == "NOT_FOUND" ]]; then
  echo "no user with email $EMAIL — nothing to do."
  exit 0
fi
echo "$REPORT"

if [[ "$YES" -ne 1 ]]; then
  read -r -p "Type the email again to DELETE this user and all their data: " CONFIRM
  [[ "$CONFIRM" == "$EMAIL" ]] || { echo "confirmation mismatch — aborted."; exit 1; }
fi

# ---- transactional delete (children first; any failure rolls the whole thing back) ----
psql "$DB_URL" -X --single-transaction -v ON_ERROR_STOP=1 -v email="$EMAIL" -v dropdealer="$DROP_DEALER" <<'SQL'
-- resolve target ids once
create temp table _target on commit drop as
  select u."id" as uid,
         (select ud.dealership_id from user_dealerships ud where ud.user_id = u."id") as dlr
  from "user" u where lower(u."email") = lower(:'email');

-- listings' non-cascading children first
delete from listing_view_snapshots
 where listing_id in (select id from listings where owner_id in (select uid from _target));
-- listings (listing_platforms cascades via FK)
delete from listings where owner_id in (select uid from _target);

delete from usage_events         where user_id in (select uid from _target);
delete from dealer_requests      where user_id in (select uid from _target);
delete from extension_auth_codes where user_id in (select uid from _target);
delete from comp_grants          where user_id in (select uid from _target);
delete from ai_usage             where user_id in (select uid from _target);
delete from user_dealerships     where user_id in (select uid from _target);
delete from "subscription"       where "referenceId" in (select uid from _target);
delete from "verification"       where lower("identifier") = lower(:'email');

-- optional: drop the (now-unlinked) dealership, but ONLY if nothing else references it.
-- (\if because psql :variables are NOT interpolated inside dollar-quoted do-blocks.)
\if :dropdealer
do $$
declare d text; other_links int; other_listings int;
begin
  select dlr into d from _target;
  if d is not null and d <> 'alexandria-toyota' then
    select count(*) into other_links from user_dealerships where dealership_id = d;
    select count(*) into other_listings from listings where dealership_id = d;
    if other_links = 0 and other_listings = 0 then
      delete from dealership_aliases where dealership_id = d;
      delete from dealer_inventory_scans where dealership_id = d;
      delete from dealerships where id = d;
      raise notice 'dropped dealership %', d;
    else
      raise notice 'kept dealership % (still referenced: % links, % listings)', d, other_links, other_listings;
    end if;
  end if;
end $$;
\endif

-- finally the user (session + account cascade via FK)
delete from "user" where "id" in (select uid from _target);
SQL

echo "done — $EMAIL fully removed. Sign up again to re-test onboarding."
echo "note: the Stripe TEST-mode customer still exists on Stripe's side (harmless; a fresh checkout creates a new one)."
