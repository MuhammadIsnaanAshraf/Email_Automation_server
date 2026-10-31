-- ============================================================
-- Agency accounts: one login that manages several sending accounts.
--
-- An agency signs up with email + password and starts 'pending'. Once an
-- admin approves it ('active') it can attach Gmail accounts — each one by
-- signing in to that Google account — up to the limit the admin set.
--
-- Every attached account is an ordinary user (its own auth.users row, Gmail
-- connection, lists, campaigns, suppressions, daily cap). Nothing about
-- sending, bounce scanning or tracking changes: the agency simply works
-- *as* that user, and the backend checks the link below on every request.
-- ============================================================

-- ── 1. Agencies ──────────────────────────────────────────────
create table if not exists public.agencies (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  name             text not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'active', 'rejected', 'suspended')),
  -- How many accounts this agency may attach. Set by an admin; lowering it
  -- below the current count keeps existing accounts but blocks new ones.
  max_sub_accounts integer not null default 5
                     check (max_sub_accounts between 0 and 1000),
  reviewed_at      timestamptz,
  reviewed_by      uuid references auth.users(id) on delete set null,
  review_note      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists agencies_status_idx on public.agencies (status, created_at desc);

drop trigger if exists agencies_updated_at on public.agencies;
create trigger agencies_updated_at
  before update on public.agencies
  for each row execute function public.update_updated_at_column();

alter table public.agencies enable row level security;

drop policy if exists "Agencies can view own row" on public.agencies;
create policy "Agencies can view own row" on public.agencies
  for select using (user_id = auth.uid());

-- ── 2. Attached accounts ─────────────────────────────────────
/* member_user_id is unique: an account belongs to at most one agency, so two
   agencies can never both be working inside the same inbox. */
create table if not exists public.agency_members (
  agency_id      uuid not null references public.agencies(user_id) on delete cascade,
  member_user_id uuid not null unique references auth.users(id) on delete cascade,
  added_at       timestamptz not null default now(),
  primary key (agency_id, member_user_id)
);

alter table public.agency_members enable row level security;

drop policy if exists "Agencies can view own members" on public.agency_members;
create policy "Agencies can view own members" on public.agency_members
  for select using (agency_id = auth.uid());

-- ── 3. Attaching an account ──────────────────────────────────
/* The only path that adds a row to agency_members. Locks the agency row so two
   accounts connected at the same moment cannot both squeeze under the limit.

   Returns one of:
     linked             — attached now
     already_linked     — was already attached to this agency (a reconnect)
     not_agency         — p_agency_id is not an agency
     agency_not_active  — pending / rejected / suspended
     self               — the agency tried to attach its own login
     member_is_agency   — the account is itself an agency
     linked_elsewhere   — attached to a different agency
     limit_reached      — at max_sub_accounts */
create or replace function public.link_agency_member(p_agency_id uuid, p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency public.agencies%rowtype;
  v_owner  uuid;
  v_count  integer;
begin
  select * into v_agency from public.agencies where user_id = p_agency_id for update;
  if not found then return 'not_agency'; end if;
  if v_agency.status <> 'active' then return 'agency_not_active'; end if;
  if p_member_id = p_agency_id then return 'self'; end if;
  if exists (select 1 from public.agencies where user_id = p_member_id) then
    return 'member_is_agency';
  end if;

  select agency_id into v_owner from public.agency_members where member_user_id = p_member_id;
  if found then
    return case when v_owner = p_agency_id then 'already_linked' else 'linked_elsewhere' end;
  end if;

  select count(*) into v_count from public.agency_members where agency_id = p_agency_id;
  if v_count >= v_agency.max_sub_accounts then return 'limit_reached'; end if;

  insert into public.agency_members (agency_id, member_user_id) values (p_agency_id, p_member_id);
  return 'linked';
end;
$$;

revoke all on function public.link_agency_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.link_agency_member(uuid, uuid) to service_role;
