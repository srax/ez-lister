-- 003_seed_alexandria: the one supported dealership in v1. Adding a dealer on a supported
-- platform is exactly this shape — one dealerships row + its aliases (later done via admin).

insert into dealerships (id, name, platform, status, timezone, config) values (
  'alexandria-toyota',
  'Alexandria Toyota',
  'dealeron',
  'supported',
  'America/New_York',
  '{
    "location": "Alexandria, VA",
    "sitemapUrl": "https://www.alexandriatoyota.com/sitemap.aspx",
    "inventoryUrls": [
      "https://www.alexandriatoyota.com/searchused.aspx",
      "https://www.alexandriatoyota.com/searchnew.aspx",
      "https://www.alexandriatoyota.com/certified-pre-owned.html"
    ]
  }'::jsonb
) on conflict (id) do nothing;

insert into dealership_aliases (domain, dealership_id) values
  ('alexandriatoyota.com', 'alexandria-toyota'),
  ('www.alexandriatoyota.com', 'alexandria-toyota')
on conflict (domain) do nothing;
