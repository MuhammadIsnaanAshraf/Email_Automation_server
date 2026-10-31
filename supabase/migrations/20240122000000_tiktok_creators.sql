-- ============================================================
-- TikTok Shop creator finder: affiliate creators in one market (default UK)
-- found by keyword, with their sales (GMV) and a contact email where one can
-- be found.
--
-- A search runs in two stages on the same provider key pool as the lead
-- finder (lead_source_keys):
--   discover — creators selling in the market, with GMV, units, growth
--   emails   — contact emails for the creators discovery returned without one
-- ============================================================

-- ── 1. Searches ──────────────────────────────────────────────
create table if not exists public.creator_searches (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  keywords          text[] not null,
  country           text not null default 'GB',
  -- Sales window the GMV figures cover: last30Day | last7Day | lastDay.
  period            text not null default 'last30Day',
  per_keyword       integer not null check (per_keyword between 1 and 1000),
  min_revenue       integer not null default 0,
  min_followers     integer not null default 0,
  find_emails       boolean not null default true,
  status            text not null default 'running'
                      check (status in ('running', 'succeeded', 'failed')),
  stage             text not null default 'discover'
                      check (stage in ('discover', 'emails', 'done')),
  -- Run in flight for the current stage, so a backend restart resumes it.
  key_fingerprint   text,
  provider_run_id   text,
  result_count      integer not null default 0,
  new_count         integer not null default 0,
  email_count       integer not null default 0,
  -- User-facing message only. Provider details are logged server-side.
  error             text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists creator_searches_user_created_idx
  on public.creator_searches (user_id, created_at desc);

-- One search in flight per account, as with lead searches: each spends credit.
create unique index if not exists creator_searches_one_running_per_user
  on public.creator_searches (user_id) where status = 'running';

alter table public.creator_searches enable row level security;

drop policy if exists "Users can view own creator searches" on public.creator_searches;
create policy "Users can view own creator searches" on public.creator_searches
  for select using (user_id = auth.uid());

-- ── 2. Creators ──────────────────────────────────────────────
/* Sales figures are the provider's estimates for `period` in `country`,
   always in USD. They are refreshed whenever a later search finds the same
   creator again. */
create table if not exists public.creators (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  -- Most recent search that returned this creator.
  search_id            uuid references public.creator_searches(id) on delete set null,
  -- TikTok creator id (or 'u:<username>' when none). Dedupe key.
  source_id            text not null,

  username             text not null,
  nickname             text,
  profile_url          text,
  avatar_url           text,
  bio                  text,
  country              text,
  matched_keyword      text,

  followers            bigint,
  revenue              numeric(14, 2),
  units_sold           integer,
  revenue_growth_pct   numeric(9, 2),
  content_views        bigint,
  avg_selling_price    numeric(10, 2),
  period               text,

  email                text,
  -- 'shop_profile' (TikTok Shop contacts) | 'bio' | 'bio_link' (link-in-bio page)
  email_source         text,
  instagram_url        text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (user_id, source_id)
);

create index if not exists creators_user_revenue_idx on public.creators (user_id, revenue desc nulls last);
create index if not exists creators_user_search_idx  on public.creators (user_id, search_id);

drop trigger if exists creators_updated_at on public.creators;
create trigger creators_updated_at
  before update on public.creators
  for each row execute function public.update_updated_at_column();

alter table public.creators enable row level security;

drop policy if exists "Users can view own creators" on public.creators;
create policy "Users can view own creators" on public.creators
  for select using (user_id = auth.uid());

drop policy if exists "Users can delete own creators" on public.creators;
create policy "Users can delete own creators" on public.creators
  for delete using (user_id = auth.uid());
