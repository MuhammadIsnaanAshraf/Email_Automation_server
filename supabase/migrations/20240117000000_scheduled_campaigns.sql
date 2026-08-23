-- ─────────────────────────────────────────────────────────────
-- Migration: 20240117000000_scheduled_campaigns.sql
-- Zenviqo — Scheduled campaigns (pick a day + time, send then)
--
-- The per-recipient timeline was already computed up front from a start time
-- (see scheduleCampaign in backend/src/services/campaigns.js), so a campaign
-- pinned to "Monday 09:00" needs no new tables — its sends simply carry future
-- scheduled_at values and the tick picks them up when they come due.
--
-- Two things had to change for that to be SAFE, and both are fixed here:
--
--   1. claim_due_sends ignored campaigns.status entirely. Pausing a campaign
--      set the flag but the tick kept sending, because the claim query never
--      joined campaigns. That is tolerable when every campaign starts sending
--      the moment it is created; it is not tolerable once a campaign can sit
--      scheduled for days, which is exactly the window in which a user changes
--      their mind. The claim now only picks up sends whose campaign is
--      actively 'scheduled' or 'sending'.
--
--   2. Nothing ever moved a campaign off 'scheduled'. With immediate sending
--      that was invisible; with a Monday-morning campaign the queue could not
--      tell "waiting for Monday" from "sending right now". refresh_campaign_
--      progress now promotes 'scheduled' → 'sending' on the first completed
--      send and stamps started_at.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Claim only sends belonging to an active campaign ──────
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
    join public.campaigns c on c.id = cs.campaign_id
    where cs.status = 'scheduled'
      and cs.scheduled_at <= now()
      -- The gate: a paused, canceled, draft or completed campaign contributes
      -- nothing. Paused rows keep their original scheduled_at and become due
      -- again the moment the campaign is resumed.
      and c.status in ('scheduled', 'sending')
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

-- ── 2. Promote scheduled → sending once delivery actually starts ──
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
        when v_remaining = 0 and v_total > 0 and status not in ('canceled', 'paused')
          then 'completed'
        -- First send is out and more remain: the campaign is no longer merely
        -- booked for a future date, it is actively delivering. Only 'scheduled'
        -- is promoted — never 'paused', which must stay paused.
        when v_remaining > 0 and (v_sent + v_failed) > 0 and status = 'scheduled'
          then 'sending'
        else status
      end,
      started_at = case
        when started_at is null and (v_sent + v_failed) > 0 then now()
        else started_at
      end,
      updated_at = now()
  where id = p_campaign_id;
end;
$$;

grant execute on function public.claim_due_sends(integer, interval) to service_role;
grant execute on function public.refresh_campaign_progress(uuid) to service_role;
