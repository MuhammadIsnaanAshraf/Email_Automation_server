-- ─────────────────────────────────────────────────────────────
-- Migration: 20240112000000_per_user_send_gap.sql
-- FlowState — Per-user send gap (pacing between individual emails)
--
-- The gap between one recipient's email and the next was hardcoded (the
-- frontend sent a fixed "1 every 2 minutes" on every schedule). This makes
-- it configurable, resolved at schedule time in this order:
--
--   1. an explicit `frequency` passed with the schedule request  (per-campaign)
--   2. this column, if set                                       (per-user)
--   3. SEND_DEFAULT_GAP_SECONDS from the backend env             (platform)
--
-- NULL means "no per-user override — use the platform default", which is
-- why this is nullable rather than defaulted: a row with an explicit value
-- is a deliberate admin decision, and we need to tell that apart from
-- "never configured" (a default would erase that distinction and freeze
-- every existing user at whatever number we picked today).
-- ─────────────────────────────────────────────────────────────

alter table public.user_settings
  add column if not exists send_gap_seconds integer
    check (send_gap_seconds is null or (send_gap_seconds >= 1 and send_gap_seconds <= 86400));

comment on column public.user_settings.send_gap_seconds is
  'Seconds between consecutive sends for this account. NULL = use SEND_DEFAULT_GAP_SECONDS.';
