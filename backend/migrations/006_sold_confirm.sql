-- 006_sold_confirm: fast sold detection needs its own clock + scan evidence.
--
-- gone_confirmed_at: when the car's own page (VDP) was FIRST confirmed gone. Selling now
-- requires two gone-confirmations ≥25min apart — first_missed_at stays as roster-absence
-- telemetry only and no longer drives the sale.
alter table listings add column if not exists gone_confirmed_at timestamptz;

-- meta: per-scan evidence for debugging false positives/negatives without storing the
-- dealer's inventory: cache headers of the roster response (age/x-cache — the 2026-07-05
-- false sold was a 73h-stale Varnish copy), roster hash, and decision counters.
alter table dealer_inventory_scans add column if not exists meta jsonb;
