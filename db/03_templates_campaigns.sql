-- ─────────────────────────────────────────────────────────────
-- FlowState — Module 3: Templates & Campaigns schema
-- Run this in the Supabase SQL editor AFTER 01 (schema.sql) and 02.
--
-- A `template` is a reusable subject + body the user writes once. The body may
-- contain personalization placeholders like {{first_name}} that get filled from
-- each recipient row at send time.
--
-- A `campaign` is the thing the sending module actually runs: a template paired
-- with a recipient list. The template's subject/body are SNAPSHOTTED onto the
-- campaign at creation, so later edits to (or deletion of) the template never
-- change a campaign that's already been scheduled/sent.
-- ─────────────────────────────────────────────────────────────

-- ── Templates ────────────────────────────────────────────────
create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  name        text not null,
  subject     text not null default '',
  body        text not null default '',
  -- Placeholder names detected in subject+body (e.g. {'first_name','company'}),
  -- kept denormalized so the UI can list a template's variables without parsing.
  variables   text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists templates_user_id_idx on public.templates(user_id);

-- ── Campaigns ────────────────────────────────────────────────
-- template_id / list_id are kept for provenance, but subject/body/recipient
-- counts are snapshotted so the campaign is self-contained for the sender.
create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  name             text not null,

  -- Provenance (nullable so deleting a template/list doesn't destroy history).
  template_id      uuid references public.templates(id) on delete set null,
  list_id          uuid references public.recipient_lists(id) on delete set null,

  -- Snapshot of what will actually be sent.
  subject          text not null,
  body             text not null,
  variables        text[] not null default '{}',

  -- How many valid recipients were on the list when the campaign was created.
  recipient_count  integer not null default 0,

  status           text not null default 'draft'
                     check (status in ('draft','scheduled','sending','sent','paused','failed','canceled')),

  scheduled_at     timestamptz,
  -- Sending pacing handed to the sender, e.g. {"count":1,"every":2,"unit":"minutes"}.
  frequency        jsonb not null default '{}'::jsonb,

  -- Progress counters the sending module updates as it runs.
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);

create index if not exists campaigns_user_id_idx on public.campaigns(user_id);
create index if not exists campaigns_status_idx on public.campaigns(status);
create index if not exists campaigns_list_id_idx on public.campaigns(list_id);

-- Lock down; only the service-role backend (which bypasses RLS) touches these.
alter table public.templates enable row level security;
alter table public.campaigns enable row level security;
