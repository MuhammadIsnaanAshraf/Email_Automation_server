-- ─────────────────────────────────────────────────────────────
-- Migration: 20240103000000_sending_functions.sql
-- FlowState — Module 4: Sending Engine Functions
-- ─────────────────────────────────────────────────────────────

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
security definer
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
security definer
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

-- Grant execute to authenticated users (for edge functions using service role)
grant execute on function public.claim_due_sends(integer, integer, interval) to authenticated;
grant execute on function public.refresh_campaign_progress(uuid) to authenticated;