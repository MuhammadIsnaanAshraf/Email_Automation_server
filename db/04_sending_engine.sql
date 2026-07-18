-- ─────────────────────────────────────────────────────────────
-- FlowState — Module 4: Sending Engine (Scheduling & Throttling)
-- Run in the Supabase SQL editor AFTER 01, 02, 03.
--
-- When a campaign is scheduled, we materialize ONE row per recipient in
-- `campaign_sends`, each with its own `scheduled_at` computed up front (paced +
-- daily-capped). A background tick (pg_cron → Edge Function) then repeatedly
-- asks "which sends are due right now, across ALL users?", atomically CLAIMS
-- them (so a second overlapping tick can't grab them again), and sends them.
-- ─────────────────────────────────────────────────────────────

-- Per-account daily send cap (Gmail free ≈ 500/day, Workspace ≈ 2000). Used at
-- schedule time to spread a big list across days, and as a runtime safety net.
alter table public.users
  add column if not exists daily_send_limit integer not null default 400;

-- ── campaign_sends: the per-recipient outbox ─────────────────
create table if not exists public.campaign_sends (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
  -- Denormalized so the claim query can cap + order per user without joins.
  user_id        uuid not null references public.users(id) on delete cascade,
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
create index if not exists campaign_sends_user_sent_idx
  on public.campaign_sends (user_id, sent_at)
  where status = 'sent';

alter table public.campaign_sends enable row level security;

-- ── Atomic claim ─────────────────────────────────────────────
-- Selects due (or crash-stuck) sends for ACTIVE campaigns, caps how many per
-- user this pass, and flips them to 'sending' in one statement. FOR UPDATE
-- SKIP LOCKED means two overlapping ticks never claim the same row, so nobody
-- is emailed twice. Returns the claimed rows for the caller to actually send.
create or replace function public.claim_due_sends(
  p_max_total    integer  default 200,   -- ceiling for the whole pass
  p_max_per_user integer  default 5,     -- anti-burst cap per account per pass
  p_lock_ttl     interval default interval '5 minutes'
)
returns setof public.campaign_sends
language plpgsql
as $$
begin
  return query
  with candidates as (
    -- Lock a superset of eligible rows (no window fn here — FOR UPDATE forbids it).
    select cs.id, cs.user_id, cs.scheduled_at
    from public.campaign_sends cs
    where (
            (cs.status = 'scheduled' and cs.scheduled_at <= now())
            or (cs.status = 'sending' and cs.locked_at is not null
                and cs.locked_at < now() - p_lock_ttl)
          )
      and exists (
            select 1 from public.campaigns c
            where c.id = cs.campaign_id
              and c.status in ('scheduled', 'sending')
          )
    order by cs.scheduled_at
    for update of cs skip locked
    limit greatest(p_max_total * 4, p_max_total)
  ),
  ranked as (
    select id,
           row_number() over (partition by user_id order by scheduled_at, id) as rn
    from candidates
  ),
  picked as (
    select id from ranked
    where rn <= p_max_per_user
    order by id
    limit p_max_total
  )
  update public.campaign_sends cs
  set status    = 'sending',
      locked_at = now(),
      attempts  = cs.attempts + 1,
      updated_at = now()
  from picked
  where cs.id = picked.id
  returning cs.*;
end;
$$;

-- ── Progress rollup ──────────────────────────────────────────
-- Recomputes a campaign's counters from its sends and advances its status to
-- 'sent' once nothing is left pending. Called by the sender after each pass so
-- counts never drift (no fragile per-send increments to race on).
create or replace function public.refresh_campaign_progress(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_sent    integer;
  v_failed  integer;
  v_pending integer;
begin
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status in ('scheduled', 'sending'))
  into v_sent, v_failed, v_pending
  from public.campaign_sends
  where campaign_id = p_campaign_id;

  update public.campaigns c
  set sent_count    = v_sent,
      failed_count  = v_failed,
      status        = case
                        when c.status in ('paused', 'canceled', 'draft') then c.status
                        when v_pending = 0 then 'sent'
                        else 'sending'
                      end,
      started_at    = coalesce(c.started_at, now()),
      completed_at  = case when v_pending = 0 then now() else c.completed_at end,
      updated_at    = now()
  where c.id = p_campaign_id;
end;
$$;
