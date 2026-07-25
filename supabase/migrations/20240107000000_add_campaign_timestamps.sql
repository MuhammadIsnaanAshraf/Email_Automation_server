alter table public.campaigns
  add column if not exists started_at   timestamptz,
  add column if not exists completed_at timestamptz;
