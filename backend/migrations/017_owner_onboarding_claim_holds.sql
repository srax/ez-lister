-- 017_owner_onboarding_claim_holds: persist the owner's optional listing-seat choice and
-- retain the exact pre-hold state for reversible support claim disputes.

alter table organization_member_profiles
  add column if not exists listing_preference text,
  add column if not exists listing_preference_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organization_member_listing_preference_check'
  ) then
    alter table organization_member_profiles
      add constraint organization_member_listing_preference_check
      check (listing_preference is null or listing_preference in ('listing', 'dashboard'));
  end if;
end $$;

alter table dealership_claims
  add column if not exists hold_from_status text,
  add column if not exists hold_rooftop_status text;
