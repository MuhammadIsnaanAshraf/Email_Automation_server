-- ─────────────────────────────────────────────────────────────
-- Migration: 20240109000000_role_in_auth_metadata.sql
-- FlowState — Move role source-of-truth from profiles.role to
-- auth.users.raw_app_meta_data
--
-- profiles is a normal table the app can read/write for a signed-in user's
-- own row — not a safe place to keep an authorization flag. raw_app_meta_data
-- can only ever be written by a service-role client, so it's the place
-- Supabase itself recommends for role/permission data. From this migration
-- on, the backend (see backend/src/middleware/supabaseAuth.js) reads role
-- from the auth user's app_metadata, never from profiles.
--
-- profiles.role is left in place (not dropped) so nothing that still reads
-- it breaks, but it is no longer authoritative for anything.
-- ─────────────────────────────────────────────────────────────

-- Every signup is unconditionally given role: 'user' in app_metadata — this
-- FORCES the value rather than trusting whatever role (if any) arrived on
-- the incoming row, so there is no signup path, client-supplied metadata, or
-- payload trick that can mint an admin account. Admin is only ever reachable
-- through the manual UPDATE below, which this insert trigger never runs for.
create or replace function public.handle_new_user_role()
returns trigger language plpgsql security definer as $$
begin
  new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'user');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_role on auth.users;
create trigger on_auth_user_created_role
  before insert on auth.users
  for each row execute function public.handle_new_user_role();

-- ── Promoting an account to admin ────────────────────────────
-- Admins can't be created through signup — run this by hand in the SQL
-- editor for each account you want to promote. Takes effect on that user's
-- very next request (the backend does a live lookup, not a JWT decode), no
-- re-login required:
--
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'admin')
--   where email = '<the account email>';
--
-- To demote back to a normal user:
--
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'user')
--   where email = '<the account email>';
