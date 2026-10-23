-- ============================================================
-- Lead finder: search a people-data provider by job title + country, store
-- the people it returns as leads for later AI-written outreach.
--
-- The provider (an Apify actor) is an implementation detail the user never
-- sees. Its API tokens live ONLY in the backend's environment (APIFY_TOKENS);
-- the database never holds a token, just a fingerprint of each one so it can
-- remember which keys have hit their monthly limit.
-- ============================================================

-- ── 1. Provider key health (service role only) ───────────────
/* One row per API token, keyed by the first 16 hex chars of sha256(token).
   A token with no row is simply untried and therefore usable.
     active    — usable
     exhausted — monthly usage limit hit; usable again after exhausted_until
     invalid   — the provider rejected the token itself (revoked/mistyped);
                 never retried until an admin resets it */
create table if not exists public.lead_source_keys (
  fingerprint     text primary key,
  status          text not null default 'active'
                    check (status in ('active', 'exhausted', 'invalid')),
  exhausted_until timestamptz,
  last_error      text,
  last_used_at    timestamptz,
  runs_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists lead_source_keys_updated_at on public.lead_source_keys;
create trigger lead_source_keys_updated_at
  before update on public.lead_source_keys
  for each row execute function public.update_updated_at_column();

-- RLS on with no policies: only the service-role backend can read or write it.
alter table public.lead_source_keys enable row level security;

-- ── 2. Searches ──────────────────────────────────────────────
create table if not exists public.lead_searches (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  titles           text[] not null,
  countries        text[] not null,
  requested_count  integer not null check (requested_count between 1 and 5000),
  status           text not null default 'running'
                     check (status in ('running', 'succeeded', 'failed')),
  -- Which key/run is in flight, so a backend restart can pick the run back up.
  key_fingerprint  text,
  provider_run_id  text,
  attempts         integer not null default 0,
  result_count     integer not null default 0,
  new_count        integer not null default 0,
  -- User-facing message only. Provider details are logged server-side.
  error            text,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index if not exists lead_searches_user_created_idx
  on public.lead_searches (user_id, created_at desc);

-- One search in flight per account: each run spends provider credit, and a
-- double-clicked button should not spend it twice.
create unique index if not exists lead_searches_one_running_per_user
  on public.lead_searches (user_id) where status = 'running';

alter table public.lead_searches enable row level security;

drop policy if exists "Users can view own lead searches" on public.lead_searches;
create policy "Users can view own lead searches" on public.lead_searches
  for select using (user_id = auth.uid());

-- ── 3. Leads ─────────────────────────────────────────────────
/* Only the fields the outreach step needs: who they are, how to reach them,
   and enough about the company for the AI to write something specific.
   Provider fields that are always null or noise (SIC, zipcode, funding,
   Alexa rank, …) are deliberately not stored. */
create table if not exists public.leads (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  -- Most recent search that returned this person.
  search_id              uuid references public.lead_searches(id) on delete set null,
  -- Provider's person id (or LinkedIn URL / email as fallback). Dedupe key.
  source_id              text not null,

  first_name             text,
  last_name              text,
  title                  text,
  department             text,
  seniority              text,
  email                  text,
  -- true when the provider derived the address from the company's naming
  -- pattern rather than finding it. Higher bounce risk.
  email_guessed          boolean not null default false,
  phone                  text,
  linkedin_url           text,
  city                   text,
  state                  text,
  country                text,

  company_name           text,
  company_website        text,
  company_linkedin_url   text,
  company_industry       text,
  company_size           integer,
  company_employee_range text,
  company_revenue        text,
  company_city           text,
  company_country        text,
  company_description    text,
  company_keywords       text[],

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (user_id, source_id)
);

create index if not exists leads_user_created_idx on public.leads (user_id, created_at desc);
create index if not exists leads_user_search_idx  on public.leads (user_id, search_id);

drop trigger if exists leads_updated_at on public.leads;
create trigger leads_updated_at
  before update on public.leads
  for each row execute function public.update_updated_at_column();

alter table public.leads enable row level security;

drop policy if exists "Users can view own leads" on public.leads;
create policy "Users can view own leads" on public.leads
  for select using (user_id = auth.uid());

drop policy if exists "Users can delete own leads" on public.leads;
create policy "Users can delete own leads" on public.leads
  for delete using (user_id = auth.uid());
