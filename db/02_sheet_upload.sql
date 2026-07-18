-- ─────────────────────────────────────────────────────────────
-- FlowState — Module 2: Sheet Upload schema
-- Run this in the Supabase SQL editor AFTER 01 (schema.sql).
--
-- An uploaded spreadsheet becomes a `recipient_lists` row plus one `recipients`
-- row per data line. Rows are parsed + validated on upload and saved as a
-- 'draft'; the user reviews the flagged preview, then confirms, which promotes
-- the list to 'ready' for use by the sending module. Invalid rows are kept and
-- flagged (never silently dropped) — the sender simply skips non-valid rows.
-- ─────────────────────────────────────────────────────────────

-- ── Recipient lists ──────────────────────────────────────────
create table if not exists public.recipient_lists (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  name            text not null,
  source_filename text,
  status          text not null default 'draft'
                    check (status in ('draft', 'ready', 'archived')),
  -- How the spreadsheet's headers were mapped to email/name/company, so the
  -- user can catch a wrongly-labeled column in the preview.
  column_map      jsonb not null default '{}'::jsonb,
  detected_headers text[] not null default '{}',
  total_rows      integer not null default 0,
  valid_rows      integer not null default 0,
  invalid_rows    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);

create index if not exists recipient_lists_user_id_idx on public.recipient_lists(user_id);
create index if not exists recipient_lists_status_idx on public.recipient_lists(status);

-- ── Recipients ───────────────────────────────────────────────
create table if not exists public.recipients (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.recipient_lists(id) on delete cascade,
  row_number  integer not null,               -- 1-based line in the source file (data rows only)
  email       text,
  name        text,
  company     text,
  extra       jsonb not null default '{}'::jsonb,  -- any columns we didn't map
  is_valid    boolean not null default true,
  errors      text[] not null default '{}',   -- blocking issues (bad/missing email)
  warnings    text[] not null default '{}',   -- non-blocking notes (e.g. duplicate)
  created_at  timestamptz not null default now()
);

create index if not exists recipients_list_id_idx on public.recipients(list_id);
create index if not exists recipients_list_valid_idx on public.recipients(list_id, is_valid);

-- Lock down; only the service-role backend (which bypasses RLS) touches these.
alter table public.recipient_lists enable row level security;
alter table public.recipients enable row level security;
