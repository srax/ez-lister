-- 005_dealer_request_contact: optional contact details for unsupported-dealer triage.

alter table dealer_requests
  add column if not exists contact_name text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists notes text;
