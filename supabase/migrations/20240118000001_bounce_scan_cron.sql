-- ─────────────────────────────────────────────────────────────
-- Migration: 20240118000001_bounce_scan_cron.sql
-- Zenviqo — Cron wiring for the bounce & block scanner
--
-- BEFORE running: deploy the function and set its secrets.
--   supabase functions deploy bounce-scan --no-verify-jwt
--   supabase secrets set BOUNCE_SCAN_SECRET=xxx      (optional — falls back
--                                                     to SEND_TICK_SECRET)
-- Then replace the two placeholders below:
--   <PROJECT_REF>        your Supabase project ref
--   <BOUNCE_SCAN_SECRET> the secret the function checks (BOUNCE_SCAN_SECRET,
--                        or SEND_TICK_SECRET if you didn't set a separate one)
--
-- Runs every 10 minutes rather than every minute. Bounces are not urgent —
-- what matters is that an address is suppressed before its NEXT campaign, not
-- within sixty seconds — and each pass costs real Gmail API quota per account.
-- ─────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('zenviqo-bounce-scan')
where exists (select 1 from cron.job where jobname = 'zenviqo-bounce-scan');

select cron.schedule(
  'zenviqo-bounce-scan',
  '*/10 * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bounce-scan',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-tick-secret', '<BOUNCE_SCAN_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- Handy checks:
--   select * from cron.job where jobname = 'zenviqo-bounce-scan';
--   select * from public.bounce_scan_state order by last_run_at desc;
--   select * from public.email_delivery_events order by reported_at desc limit 20;
--   select * from public.email_suppressions where status = 'suppressed';
