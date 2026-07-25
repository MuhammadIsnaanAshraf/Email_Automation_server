-- ─────────────────────────────────────────────────────────────
-- Migration: 20240103000000_send_claim_functions.sql
-- FlowState — Module 4: Sending Engine (claim + progress functions)
--
-- claim_due_sends() and refresh_campaign_progress() are called every tick
-- by the send-tick Edge Function but were never defined in any migration
-- (confirmed missing from the live database via `supabase db dump`), so
-- the tick has been failing on the RPC call. This adds them.
-- ─────────────────────────────────────────────────────────────

-- Tracks how many times a row got bumped to a later slot purely because
-- its account already had a pick this tick (distinct from `attempts`,
-- which counts real send failures).
alter table public.campaign_sends
  add column if not exists reschedule_count integer not null default 0;

-- Atomically claims due sends across all users, at most `p_max_per_user`
-- per account per call (default 1 — one send per account per minute,
-- since the tick runs every minute). No cap on the total claimed in one
-- pass: the natural ceiling is "one per account with something due".
--
-- Selection is oldest-due-first per account (not "due within this exact
-- minute"), so a tick that was skipped or ran late still drains its
-- backlog at the same one-per-account-per-minute rate instead of
-- stalling forever. Any other due row for an account that already got
-- its pick this tick is explicitly pushed to the next minute boundary
-- and flagged via reschedule_count — it is never left behind with a
-- stale, in-the-past scheduled_at, and it is never marked sent for the
-- slot it missed.
create or replace function public.claim_due_sends(
  p_max_per_user integer default 1,
  p_lock_ttl interval default '5 minutes'
)
returns setof public.campaign_sends
language plpgsql
as $$
declare
  v_next_slot timestamptz := date_trunc('minute', now()) + interval '1 minute';
begin
  -- Reclaim rows stuck in 'sending' from a crashed/timed-out pass so
  -- they're eligible again instead of stranded forever.
  update public.campaign_sends
  set status = 'scheduled', locked_at = null
  where status = 'sending' and locked_at < now() - p_lock_ttl;

  return query
  with due as (
    select cs.id,
           row_number() over (
             partition by cs.user_id order by cs.scheduled_at asc, cs.id asc
           ) as rn
    from public.campaign_sends cs
    where cs.status = 'scheduled' and cs.scheduled_at <= now()
  ),
  locked as (
    select due.id, due.rn
    from due
    join public.campaign_sends cs on cs.id = due.id
    where cs.status = 'scheduled'
    for update of cs skip locked
  ),
  overflow as (
    update public.campaign_sends cs
    set scheduled_at = v_next_slot,
        reschedule_count = cs.reschedule_count + 1,
        updated_at = now()
    from locked
    where locked.id = cs.id and locked.rn > p_max_per_user
  ),
  claimed as (
    update public.campaign_sends cs
    set status = 'sending', locked_at = now(), updated_at = now()
    from locked
    where locked.id = cs.id and locked.rn <= p_max_per_user
    returning cs.*
  )
  select * from claimed;
end;
$$;

-- Recomputes a campaign's sent/failed counts and flips it to 'completed'
-- once nothing is left scheduled/sending.
create or replace function public.refresh_campaign_progress(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_sent integer;
  v_failed integer;
  v_total integer;
  v_remaining integer;
begin
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*),
    count(*) filter (where status in ('scheduled', 'sending'))
  into v_sent, v_failed, v_total, v_remaining
  from public.campaign_sends
  where campaign_id = p_campaign_id;

  update public.campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      status = case
        when v_remaining = 0 and v_total > 0 and status not in ('cancelled', 'paused')
          then 'completed'
        else status
      end,
      updated_at = now()
  where id = p_campaign_id;
end;
$$;

grant execute on function public.claim_due_sends(integer, interval) to service_role;
grant execute on function public.refresh_campaign_progress(uuid) to service_role;
