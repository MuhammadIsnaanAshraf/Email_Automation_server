-- ─────────────────────────────────────────────────────────────
-- Migration: 20240101000000_initial_schema.sql
-- FlowState — Module 1-3: Core Tables (Auth, Lists, Templates, Campaigns)
-- ─────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Updated_at trigger helper ────────────────────────────────
create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Profiles ───────────────────────────────────────────────────
-- Public profile table, populated from auth.users via trigger.
-- Extensible for additional user metadata.
create table if not exists public.profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text not null,
  name      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at_column();

-- Sync auth.users → profiles
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do update set
    email = excluded.email,
    name = excluded.name,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── User settings ──────────────────────────────────────────────
-- Per-user configuration (daily send limit, etc.)
create table if not exists public.user_settings (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  daily_send_limit integer not null default 400,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.update_updated_at_column();

-- Auto-create settings on user signup
create or replace function public.handle_new_user_settings()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_settings on auth.users;
create trigger on_auth_user_created_settings
  after insert on auth.users
  for each row execute function public.handle_new_user_settings();

-- ── Google connections ───────────────────────────────────────
create table if not exists public.google_connections (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  refresh_token  text,
  access_token   text,
  token_expiry   timestamptz,
  scopes         text[] not null default '{}',
  status         text not null default 'connected'
                   check (status in ('connected', 'expired', 'revoked', 'error')),
  last_error     text,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

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
  user_id            uuid not null references auth.users(id) on delete cascade,
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
create index if not exists recipients_user_id_idx on public.recipients(user_id);
create index if not exists recipients_user_list_idx on public.recipients(user_id, list_id);

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

-- ── Updated_at trigger helper ────────────────────────────────
create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Lock everything down; only the service role (our backend) bypasses RLS.
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.google_connections enable row level security;
alter table public.recipient_lists enable row level security;
alter table public.recipients enable row level security;
alter table public.templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.system_logs enable row level security;

-- ── RLS Policies ─────────────────────────────────────────────

-- profiles
create policy "Users can view own profile" on public.profiles
  for select using (id = auth.uid());

create policy "Users can update own profile" on public.profiles
  for update using (id = auth.uid());

-- user_settings
create policy "Users can view own settings" on public.user_settings
  for select using (user_id = auth.uid());

create policy "Users can update own settings" on public.user_settings
  for update using (user_id = auth.uid());

-- google_connections
create policy "Users can view own connections" on public.google_connections
  for select using (user_id = auth.uid());

create policy "Users can insert own connections" on public.google_connections
  for insert with check (user_id = auth.uid());

create policy "Users can update own connections" on public.google_connections
  for update using (user_id = auth.uid());

-- recipient_lists
create policy "Users can view own lists" on public.recipient_lists
  for select using (user_id = auth.uid());

create policy "Users can insert own lists" on public.recipient_lists
  for insert with check (user_id = auth.uid());

create policy "Users can update own lists" on public.recipient_lists
  for update using (user_id = auth.uid());

create policy "Users can delete own lists" on public.recipient_lists
  for delete using (user_id = auth.uid());

-- recipients
create policy "Users can view own recipients" on public.recipients
  for select using (user_id = auth.uid());

create policy "Users can insert own recipients" on public.recipients
  for insert with check (user_id = auth.uid());

create policy "Users can update own recipients" on public.recipients
  for update using (user_id = auth.uid());

create policy "Users can delete own recipients" on public.recipients
  for delete using (user_id = auth.uid());

-- templates
create policy "Users can view own templates" on public.templates
  for select using (user_id = auth.uid());

create policy "Users can insert own templates" on public.templates
  for insert with check (user_id = auth.uid());

create policy "Users can update own templates" on public.templates
  for update using (user_id = auth.uid());

create policy "Users can delete own templates" on public.templates
  for delete using (user_id = auth.uid());

-- campaigns
create policy "Users can view own campaigns" on public.campaigns
  for select using (user_id = auth.uid());

create policy "Users can insert own campaigns" on public.campaigns
  for insert with check (user_id = auth.uid());

create policy "Users can update own campaigns" on public.campaigns
  for update using (user_id = auth.uid());

create policy "Users can delete own campaigns" on public.campaigns
  for delete using (user_id = auth.uid());

-- campaign_recipients
create policy "Users can view own campaign recipients" on public.campaign_recipients
  for select using (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  );

create policy "Users can insert own campaign recipients" on public.campaign_recipients
  for insert with check (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  );

create policy "Users can update own campaign recipients" on public.campaign_recipients
  for update using (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  );

-- system_logs (read-only for users, write-only for service role)
create policy "Users can view own logs" on public.system_logs
  for select using (
    exists (select 1 from public.recipient_lists l where l.user_id = auth.uid())
  );