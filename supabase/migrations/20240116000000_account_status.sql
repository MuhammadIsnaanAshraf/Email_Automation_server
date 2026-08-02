-- ─────────────────────────────────────────────────────────────
-- Migration: 20240116000000_account_status.sql
-- Zenviqo — Manual account status (active / inactive)
--
-- Same threat model as role (see 20240109000000_role_in_auth_metadata.sql):
-- this is a kill switch, so it lives in auth.users.raw_app_meta_data, which
-- only a service-role client can ever write. There is deliberately NO API
-- endpoint that sets this — the only way an account becomes 'inactive' is a
-- manual SQL UPDATE run by hand in the SQL editor (see the query below).
-- Every account defaults to 'active' and stays that way through normal use.
-- ─────────────────────────────────────────────────────────────

-- Every signup is unconditionally given status: 'active' — forced, not
-- merged, for the same reason role is forced: no signup payload should be
-- able to determine its own account status.
create or replace function public.handle_new_user_status()
returns trigger language plpgsql security definer as $$
begin
  new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('status', 'active');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_status on auth.users;
create trigger on_auth_user_created_status
  before insert on auth.users
  for each row execute function public.handle_new_user_status();

-- ── Deactivating an account ──────────────────────────────────
-- Run by hand in the SQL editor. There is no admin-panel control for this
-- on purpose — it's a manual, deliberate action:
--
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('status', 'inactive')
--   where email = '<the account email>';
--
-- To reactivate:
--
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('status', 'active')
--   where email = '<the account email>';
--
-- Takes effect on that user's very next request (requireAuth does a live
-- lookup against auth.users, not a decode of the JWT's original claims) —
-- no re-login required, same as role promotion.
