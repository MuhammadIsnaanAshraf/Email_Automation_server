-- ─────────────────────────────────────────────────────────────
-- FlowState — Module 4: Cron wiring (pg_cron → Edge Function)
--
-- This is what makes sending run "in the background with no server". pg_cron
-- fires every minute and uses pg_net to POST to the `send-tick` Edge Function,
-- which claims and sends whatever is due.
--
-- BEFORE running: deploy the function and set its secrets (see backend README
-- "Module 4"). Then replace the two placeholders below:
--   <PROJECT_REF>       your Supabase project ref (e.g. abcdefgh)
--   <SEND_TICK_SECRET>  the same value you set as the function's SEND_TICK_SECRET
-- ─────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous schedule so re-running this file is safe.
select cron.unschedule('flowstate-send-tick')
where exists (select 1 from cron.job where jobname = 'flowstate-send-tick');

-- Tick every minute.
select cron.schedule(
  'flowstate-send-tick',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-tick',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-tick-secret', '<SEND_TICK_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- Handy checks:
--   select * from cron.job;                                  -- confirm it's scheduled
--   select * from cron.job_run_details order by start_time desc limit 10;  -- recent runs
--   select cron.unschedule('flowstate-send-tick');           -- stop ticking
