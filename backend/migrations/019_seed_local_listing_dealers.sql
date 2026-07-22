-- 019_seed_local_listing_dealers: curated listing support for the two local dealerships used by
-- the field pilot. These are exact domain aliases, so a fresh salesperson account can connect
-- immediately without enabling broad platform auto-onboarding.

insert into dealerships (id, name, platform, status, timezone, config) values
  (
    'vl-auto-sales',
    'V & L Auto Sales',
    'carsforsale',
    'supported',
    'America/New_York',
    '{
      "location": "Harrisonburg, VA",
      "inventoryUrls": ["https://www.vlautosales.com/cars-for-sale"]
    }'::jsonb
  ),
  (
    'keiths-auto-sales',
    'Keith''s Auto Sales',
    'autocorner',
    'supported',
    'America/New_York',
    '{
      "location": "Penn Laird, VA",
      "inventoryUrls": ["https://www.keithsautosales.com/docs/vehicle_search.html"]
    }'::jsonb
  )
on conflict (id) do nothing;

insert into dealership_aliases (domain, dealership_id) values
  ('vlautosales.com', 'vl-auto-sales'),
  ('www.vlautosales.com', 'vl-auto-sales'),
  ('keithsautosales.com', 'keiths-auto-sales'),
  ('www.keithsautosales.com', 'keiths-auto-sales')
on conflict (domain) do nothing;
