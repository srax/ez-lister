-- 008_dealer_outcome: Part 2 of inventory sold-detection — the user's classification of a car
-- that left the dealership's own site.
--
--   dealer_outcome: 'fb' | 'craigslist' (the DEALERSHIP sold it — someone other than this user)
--                 | 'delisted'          (removed for any other reason; NOT a sale)
--   dealer_outcome_at: when the user classified it.
--
-- The needs-action signal itself is gone_confirmed_at (006), now also set by the extension's
-- presence reports via the two-confirm rule in recordPresence (never by a single miss).
alter table listings add column if not exists dealer_outcome text;
alter table listings add column if not exists dealer_outcome_at timestamptz;
