-- ─────────────────────────────────────────────────────────────
-- Migration: 20240105000000_add_profile_role.sql
-- FlowState — Role-based access control (admin vs. normal user)
--
-- Every account defaults to 'user'. To promote an account to admin, run:
--   update public.profiles set role = 'admin' where email = '<the account email>';
-- ─────────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists role text not null default 'user' check (role in ('user', 'admin'));
