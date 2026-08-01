-- ─────────────────────────────────────────────────────────────
-- Migration: 20240114000000_admin_user_list_view.sql
-- FlowState — Single-query admin user list
--
-- PostgREST couldn't resolve an embed between profiles and
-- google_connections/user_settings/user_subscription_status in this project
-- (the child tables FK to auth.users, not to profiles, and the subscription
-- status is a view), so instead of one DB lookup per resource per page the
-- admin list reads ONE denormalized view. Each child table is 1:1-or-0 with
-- profiles (user_id is unique in each), so the LEFT JOINs never fan out rows
-- and the view's row count always equals the number of profiles.
-- ─────────────────────────────────────────────────────────────

create or replace view public.admin_user_list as
select
  p.id,
  p.email,
  p.name,
  p.whatsapp_number,
  p.created_at,
  gc.status as gmail_status,
  gc.token_expiry,
  us.daily_send_limit,
  us.send_gap_seconds,
  sp.period_start,
  sp.period_end,
  sp.amount,
  sp.currency,
  sp.payment_method,
  sp.last_activated_at
from public.profiles p
left join public.google_connections gc on gc.user_id = p.id
left join public.user_settings us on us.user_id = p.id
left join public.user_subscription_status sp on sp.user_id = p.id;
