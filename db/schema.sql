-- ─────────────────────────────────────────────────────────────
-- FlowState — Module 1: Authentication schema (Supabase Auth)
-- Run this in the Supabase SQL editor (or via the CLI) once.
--
-- We use Supabase Auth's built-in auth.users table for user identity.
-- The backend validates Supabase JWT tokens directly via the Auth API.
-- ─────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Google connections ───────────────────────────────────────
-- The Gmail-sending grant for a user. Refresh token is stored encrypted.
-- `status` lets the app tell the user when the connection needs re-linking
-- instead of failing silently at send time.
create table if not exists public.google_connections (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  refresh_token  text,                        -- encrypted (AES-256-GCM), may be null if Google didn't return one
  access_token   text,                        -- encrypted; short-lived, refreshed as needed
  token_expiry   timestamptz,                 -- when the access_token expires
  scopes         text[] not null default '{}',
  status         text not null default 'connected'
                   check (status in ('connected', 'expired', 'revoked', 'error')),
  last_error     text,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Sessions ─────────────────────────────────────────────────
-- Supabase Auth handles sessions via JWT tokens. No custom sessions table needed.

-- ── Recipient lists ──────────────────────────────────────────
create table if not exists public.recipient_lists (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  name             text,
  status           text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  source_filename  text,
  column_map       jsonb not null default '{}',
  detected_headers text[] not null default '{}',
  total_rows       int not null default 0,
  valid_rows       int not null default 0,
  invalid_rows     int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists recipient_lists_user_id_idx on public.recipient_lists(user_id);

-- ── Recipients ───────────────────────────────────────────────
create table if not exists public.recipients (
  id                 uuid primary key default gen_random_uuid(),
  list_id            uuid not null references public.recipient_lists(id) on delete cascade,
  email              text not null,
  normalized_email   text not null,
  name               text,
  company            text,
  row_number         int,
  is_valid           boolean not null default true,
  errors             text[] not null default '{}',
  warnings           text[] not null default '{}',
  extra_data         jsonb not null default '{}',
  created_at         timestamptz not null default now()
);

create index if not exists recipients_list_id_idx on public.recipients(list_id);
create index if not exists recipients_list_email_idx on public.recipients(list_id, normalized_email);

-- ── Templates ────────────────────────────────────────────────
create table if not exists public.templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  subject      text not null,
  body         text not null,
  variables    text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists templates_user_id_idx on public.templates(user_id);

-- ── Campaigns ────────────────────────────────────────────────
create table if not exists public.campaigns (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text,
  template_id     uuid references public.templates(id) on delete set null,
  list_id         uuid not null references public.recipient_lists(id) on delete cascade,
  subject         text not null,
  body            text not null,
  variables       text[] not null default '{}',
  status          text not null default 'draft'
                    check (status in ('draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed')),
  scheduled_at    timestamptz,
  frequency       jsonb,
  total_recipients int not null default 0,
  sent_count      int not null default 0,
  failed_count    int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists campaigns_user_id_idx on public.campaigns(user_id);
create index if not exists campaigns_status_idx on public.campaigns(status);

-- ── Campaign recipients (snapshotted per send) ───────────────
create table if not exists public.campaign_recipients (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  recipient_id  uuid not null references public.recipients(id) on delete cascade,
  send_time     timestamptz,
  status        text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed', 'skipped')),
  error         text,
  attempts      int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists campaign_recipients_campaign_id_idx on public.campaign_recipients(campaign_id);
create index if not exists campaign_recipients_send_time_idx on public.campaign_recipients(send_time);

-- ── System logs ──────────────────────────────────────────────
create table if not exists public.system_logs (
  id          bigserial primary key,
  level       text not null check (level in ('debug', 'info', 'warn', 'error')),
  message     text not null,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists system_logs_created_at_idx on public.system_logs(created_at desc);

-- Lock everything down; only the service role (our backend) bypasses RLS.
alter table public.google_connections enable row level security;
alter table public.recipient_lists enable row level security;
alter table public.recipients enable row level security;
alter table public.templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.system_logs enable row level security;