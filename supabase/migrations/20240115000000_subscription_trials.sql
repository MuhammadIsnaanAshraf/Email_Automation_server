-- ─────────────────────────────────────────────────────────────
-- Migration: 20240115000000_subscription_trials.sql
-- Zenviqo — Free trials (one per account, lifetime)
--
-- A trial is just another row in subscription_payments (amount 0,
-- payment_method 'trial') — it reuses the exact same ledger, the exact same
-- user_subscription_status "latest row wins" view, the exact same
-- active/expired computation, and the exact same reminder tick. Nothing
-- downstream needs to know a period came from a trial vs. a real payment;
-- when period_end passes, access is cut off exactly like any other lapse.
--
-- "Only once, ever" is enforced by EXISTENCE, not a separate flag: the
-- ledger is append-only and never deleted, so "has this user ever had a
-- payment_method='trial' row" is a permanent, tamper-proof record that
-- survives regardless of how many real subscriptions come after it.
-- ─────────────────────────────────────────────────────────────

alter table public.subscription_payments
  drop constraint if exists subscription_payments_payment_method_check;

alter table public.subscription_payments
  add constraint subscription_payments_payment_method_check
  check (payment_method in ('bank_transfer', 'jazzcash', 'cash', 'other', 'trial'));

-- Tiny partial index: only trial rows, only for the "has this user used
-- their trial" existence check — cheap because there's at most one such row
-- per user, ever.
create index if not exists subscription_payments_trial_idx
  on public.subscription_payments(user_id)
  where payment_method = 'trial';

-- Surface trial-used on the same denormalized admin list view the general
-- Users page already reads (see 20240114000000_admin_user_list_view.sql),
-- so the admin can see it there too without an extra round trip.
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
  sp.last_activated_at,
  exists(
    select 1 from public.subscription_payments t
    where t.user_id = p.id and t.payment_method = 'trial'
  ) as trial_used
from public.profiles p
left join public.google_connections gc on gc.user_id = p.id
left join public.user_settings us on us.user_id = p.id
left join public.user_subscription_status sp on sp.user_id = p.id;
