-- ─────────────────────────────────────────────────────────────
-- Migration: 20240110000000_subscriptions.sql
-- FlowState — Manual subscription/payment tracking
--
-- There is no payment gateway. The admin receives payment out-of-band (bank
-- transfer, JazzCash, cash) and manually activates it here. This table is an
-- append-only ledger of every activation — never overwritten — so:
--   - "current status" for a user is simply their latest row (by period_end)
--   - "history" is just every row for that user, no separate bookkeeping
--   - "renew before expiry extends, doesn't restart" falls out naturally:
--     the caller computes period_start = max(now(), current period_end)
--
-- Amount is per-row (not a fixed plan price) so different users can be
-- charged different amounts without any special-casing.
-- ─────────────────────────────────────────────────────────────

-- Where to send WhatsApp expiry reminders. Nullable — reminders are simply
-- skipped (and logged) for a user with none on file.
alter table public.profiles
  add column if not exists whatsapp_number text;

create table if not exists public.subscription_payments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,

  amount            numeric(10,2) not null check (amount >= 0),
  currency          text not null default 'PKR',
  payment_method    text not null default 'other' check (payment_method in ('bank_transfer', 'jazzcash', 'cash', 'other')),
  note              text,

  -- The access period this payment buys. period_start = max(now(), prior
  -- period_end) at activation time, period_end = period_start + 30 days —
  -- computed in application code (backend/src/services/subscriptions.js),
  -- not here, so the 30-day rule lives in one place.
  period_start      timestamptz not null,
  period_end        timestamptz not null,
  check (period_end > period_start),

  activated_by      uuid references auth.users(id),

  -- Reminder dedupe: set once each is sent for THIS period, so a renewal
  -- (a new row) naturally gets its own fresh pair of reminders.
  reminder_3d_sent_at timestamptz,
  reminder_1d_sent_at timestamptz,

  created_at        timestamptz not null default now()
);

create index if not exists subscription_payments_user_period_idx
  on public.subscription_payments(user_id, period_end desc);

-- Drives the reminder tick: "which currently-active periods expire soon and
-- haven't been reminded yet" without scanning the whole table.
create index if not exists subscription_payments_period_end_idx
  on public.subscription_payments(period_end);

-- Latest payment per user = their current subscription state. `distinct on`
-- keeps this a single indexed-sort scan rather than a per-user subquery.
create or replace view public.user_subscription_status as
select distinct on (sp.user_id)
  sp.user_id,
  sp.id             as payment_id,
  sp.period_start,
  sp.period_end,
  sp.amount,
  sp.currency,
  sp.payment_method,
  sp.note,
  sp.activated_by,
  sp.reminder_3d_sent_at,
  sp.reminder_1d_sent_at,
  sp.created_at     as last_activated_at,
  (sp.period_end > now()) as is_active
from public.subscription_payments sp
order by sp.user_id, sp.period_end desc;

alter table public.subscription_payments enable row level security;

-- Users can see their own payment history; only the service-role backend
-- (which bypasses RLS) ever activates one — there is deliberately no insert/
-- update policy for the authenticated role.
create policy "Users can view own subscription payments" on public.subscription_payments
  for select using (user_id = auth.uid());
