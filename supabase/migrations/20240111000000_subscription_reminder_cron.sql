-- ─────────────────────────────────────────────────────────────
-- Migration: 20240111000000_subscription_reminder_cron.sql
-- FlowState — Module 5: Cron wiring (pg_cron → subscription-reminders)
-- ─────────────────────────────────────────────────────────────

-- BEFORE running: deploy the subscription-reminders Edge Function and set
-- its secrets (SUBSCRIPTION_REMINDER_SECRET, plus the WhatsApp ones — see
-- backend/supabase/functions/subscription-reminders/whatsapp.ts).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('flowstate-subscription-reminders')
where exists (select 1 from cron.job where jobname = 'flowstate-subscription-reminders');

-- Once a day is enough — reminders are day-granularity (3 days left, 1 day
-- left), not minute-granularity like the send tick.
select cron.schedule(
  'flowstate-subscription-reminders',
  '0 10 * * *',
  $$
    select net.http_post(
      url     := 'https://arlrteapvqgidexxiein.supabase.co/functions/v1/subscription-reminders',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-tick-secret', '44b607de7c6cfc3f8525c097bfd087a97622d7a51362d95c62184f8bfbac75bd'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- Handy checks:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select cron.unschedule('flowstate-subscription-reminders');
