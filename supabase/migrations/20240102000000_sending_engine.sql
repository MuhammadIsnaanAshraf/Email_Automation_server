-- ─────────────────────────────────────────────────────────────
-- Migration: 20240102000000_sending_engine.sql
-- FlowState — Module 4: Sending Engine (Scheduling & Throttling)
-- ─────────────────────────────────────────────────────────────

-- Per-account daily send cap (Gmail free ≈ 500/day, Workspace ≈ 2000).
-- Used at schedule time to spread a big list across days, and as a runtime safety net.
-- We store this on the auth.users table via a custom metadata field since we can't alter auth.users directly.
-- Instead, we'll use a separate table for user settings.

create table if not exists public.user_settings (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  daily_send_limit  integer not null default 400,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── campaign_sends: the per-recipient outbox ─────────────────
create table if not exists public.campaign_sends (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
  -- Denormalized so the claim query can cap + order per user without joins.
  user_id        uuid not null references auth.users(id) on delete cascade,
  recipient_id   uuid references public.recipients(id) on delete set null,

  -- Snapshot of the recipient (personalization data) so the sender is self
  -- contained even if the source list is later edited/deleted.
  email          text not null,
  name           text,
  company        text,
  extra          jsonb not null default '{}'::jsonb,

  scheduled_at   timestamptz not null,       -- this recipient's own turn
  status         text not null default 'scheduled'
                   check (status in ('scheduled','sending','sent','failed','canceled')),
  attempts       integer not null default 0,
  locked_at      timestamptz,                -- set when claimed ('sending')
  sent_at        timestamptz,
  gmail_message_id text,
  error          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The hot path: "scheduled rows whose time has arrived", scanned every minute.
create index if not exists campaign_sends_due_idx
  on public.campaign_sends (scheduled_at)
  where status = 'scheduled';
-- Reclaiming rows stuck in 'sending' after a crashed pass.
create index if not exists campaign_sends_inflight_idx
  on public.campaign_sends (locked_at)
  where status = 'sending';
create index if not exists campaign_sends_campaign_idx on public.campaign_sends (campaign_id);
-- Fast daily-count per account.
create index if not exists campaign_sends_user_date_idx on public.campaign_sends (user_id, scheduled_at);

-- RLS policies
alter table public.user_settings enable row level security;
alter table public.campaign_sends enable row level security;

create policy "Users can view own settings" on public.user_settings
  for select using (user_id = auth.uid());

create policy "Users can upsert own settings" on public.user_settings
  for insert with check (user_id = auth.uid())
  for update using (user_id = auth.uid());

create policy "Users can view own campaign sends" on public.campaign_sends
  for select using (user_id = auth.uid());

create policy "Users can insert own campaign sends" on public.campaign_sends
  for insert with check (user_id = auth.uid());

create policy "Users can update own campaign sends" on public.campaign_sends
  for update using (user_id = auth.uid());