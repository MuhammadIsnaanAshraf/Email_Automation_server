-- ─────────────────────────────────────────────────────────────
-- Migration: 20240118000000_campaign_followups.sql
-- Follow-up email sequences — templates can carry one or more follow-up
-- emails (their own subject/body + "wait N days after the previous email"),
-- and a campaign snapshots the ones the user chose to send at creation time,
-- exactly like it already snapshots the main subject/body.
--
-- All three additions are additive with safe defaults, so every existing
-- template/campaign/send keeps behaving exactly as it does today: no
-- follow-ups selected means `sequence_step` is always 0, which is the only
-- value that ever existed before this migration.
-- ─────────────────────────────────────────────────────────────

alter table public.templates
  add column if not exists follow_ups jsonb not null default '[]'::jsonb;

alter table public.campaigns
  add column if not exists follow_ups jsonb not null default '[]'::jsonb;

alter table public.campaign_sends
  add column if not exists sequence_step integer not null default 0;

create index if not exists campaign_sends_sequence_idx
  on public.campaign_sends (campaign_id, sequence_step);

-- ── refresh_campaign_progress: step-aware ────────────────────
-- sent_count/failed_count and the "does an outbox exist yet" guard stay
-- scoped to sequence_step = 0 (the initial batch) — that's what
-- campaigns.total_recipients has always counted, so the progress bar and
-- stat cards keep meaning exactly what they mean today even once a campaign
-- has follow-ups queued behind it.
--
-- Completion, however, has to look across EVERY step: claim_due_sends only
-- claims sends whose campaign is 'scheduled' or 'sending' (see
-- 20240117000000_scheduled_campaigns.sql), so flipping to 'completed' the
-- moment the initial batch finishes would strand every future follow-up row
-- forever — the tick would simply never be allowed to claim them.
create or replace function public.refresh_campaign_progress(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_sent integer;
  v_failed integer;
  v_total integer;
  v_remaining_all integer;
begin
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*)
  into v_sent, v_failed, v_total
  from public.campaign_sends
  where campaign_id = p_campaign_id and sequence_step = 0;

  select count(*) filter (where status in ('scheduled', 'sending'))
  into v_remaining_all
  from public.campaign_sends
  where campaign_id = p_campaign_id;

  update public.campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      status = case
        when v_remaining_all = 0 and v_total > 0 and status not in ('canceled', 'paused')
          then 'completed'
        -- First send is out and more remain: the campaign is no longer merely
        -- booked for a future date, it is actively delivering. Only 'scheduled'
        -- is promoted — never 'paused', which must stay paused.
        when v_remaining_all > 0 and (v_sent + v_failed) > 0 and status = 'scheduled'
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

grant execute on function public.refresh_campaign_progress(uuid) to service_role;
