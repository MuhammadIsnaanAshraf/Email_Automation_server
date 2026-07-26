-- Fix inconsistent spelling: standardize on 'canceled' (American English)
-- across all tables and functions. The original migrations used 'cancelled'
-- (British) while application code uses 'canceled' (American).

-- 1. campaigns.status check constraint
alter table public.campaigns
  drop constraint if exists campaigns_status_check,
  add constraint campaigns_status_check
    check (status in ('draft', 'scheduled', 'sending', 'paused', 'completed', 'canceled', 'failed'));

-- 2. Recreate the send-tick function with 'canceled' spelling
create or replace function public.update_campaign_counts(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_total  int;
  v_sent   int;
  v_failed int;
  v_remaining int;
begin
  select count(*) into v_total
  from public.campaign_sends
  where campaign_id = p_campaign_id;

  select count(*) into v_sent
  from public.campaign_sends
  where campaign_id = p_campaign_id
    and status = 'sent';

  select count(*) into v_failed
  from public.campaign_sends
  where campaign_id = p_campaign_id
    and status = 'failed';

  v_remaining := v_total - v_sent - v_failed;

  update public.campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      status = case
        when v_remaining = 0 and v_total > 0 and status not in ('canceled', 'paused')
          then 'completed'
        else status
      end,
      updated_at = now()
  where id = p_campaign_id;
end;
$$;
