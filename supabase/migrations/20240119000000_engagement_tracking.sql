-- ─────────────────────────────────────────────────────────────
-- Migration: 20240119000000_engagement_tracking.sql
-- Zenviqo — Engagement tracking: opens, clicks, replies
--
-- Same three signals every sending platform reports, gathered the same way:
--
--   open   → a per-send 1×1 image appended to the HTML body. When the
--            recipient's mail client loads images, the `track` Edge Function
--            sees the request.
--   click  → every http(s) link is rewritten to pass through `track`, which
--            records the click and 302s to the original URL. The link is
--            HMAC-signed so the redirect can't be abused as an open redirect.
--   reply  → the bounce-scan pass also reads the sending account's mailbox for
--            messages in the thread of a send (gmail_thread_id), not sent by
--            the account itself. No body instrumentation needed, so replies are
--            tracked for every campaign whether or not open/click tracking is on.
--
-- ── What is NOT counted ──────────────────────────────────────
-- Raw pixel/redirect hits overstate engagement badly: corporate link scanners
-- click every link on delivery, and Apple Mail Privacy Protection fetches every
-- image whether or not the message is ever read. Every hit is stored in
-- email_engagement_events for audit, but only `counted = true` rows move the
-- counters. filter_reason says why a hit was set aside:
--   'scanner'        known security-scanner / bot user agent
--   'prefetch'       arrived within seconds of the send (no human is that fast)
--   'privacy_proxy'  Apple MPP's image proxy — loads on delivery, not on open
--   'head_request'   HEAD probe, which a browser never sends for a click
--   'auto_reply'     out-of-office / autoresponder (reply kind only)
--
-- Open/click tracking is opt-in PER CAMPAIGN. The column defaults to false so
-- every campaign that existed before this migration keeps sending exactly the
-- body it was created with; new campaigns get it switched on by the backend
-- unless the user turns it off.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Campaign: switches + unique-recipient counters ────────
alter table public.campaigns
  add column if not exists track_opens   boolean not null default false,
  add column if not exists track_clicks  boolean not null default false,
  -- Unique recipients (sends), not raw hits. A campaign's open rate is
  -- opened_count / delivered sends.
  add column if not exists opened_count  integer not null default 0,
  add column if not exists clicked_count integer not null default 0,
  add column if not exists replied_count integer not null default 0;

-- ── 2. Per-send engagement rollup ────────────────────────────
alter table public.campaign_sends
  add column if not exists open_count       integer not null default 0,
  add column if not exists first_opened_at  timestamptz,
  add column if not exists last_opened_at   timestamptz,
  add column if not exists click_count      integer not null default 0,
  add column if not exists first_clicked_at timestamptz,
  add column if not exists last_clicked_at  timestamptz,
  add column if not exists reply_count      integer not null default 0,
  add column if not exists replied_at       timestamptz,
  -- An autoresponder answered. Kept apart from replied_at so an out-of-office
  -- never inflates the reply rate, but still visible on the recipient.
  add column if not exists auto_replied_at  timestamptz;

-- Engagement filters on the campaign detail page.
create index if not exists campaign_sends_opened_idx
  on public.campaign_sends (campaign_id, first_opened_at)
  where first_opened_at is not null;
create index if not exists campaign_sends_clicked_idx
  on public.campaign_sends (campaign_id, first_clicked_at)
  where first_clicked_at is not null;
create index if not exists campaign_sends_replied_idx
  on public.campaign_sends (campaign_id, replied_at)
  where replied_at is not null;

-- ── 3. Event log ─────────────────────────────────────────────
create table if not exists public.email_engagement_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  send_id            uuid not null references public.campaign_sends(id) on delete cascade,
  campaign_id        uuid references public.campaigns(id) on delete cascade,

  kind               text not null check (kind in ('open', 'click', 'reply')),
  -- Click target (the original URL, never the tracking URL).
  url                text,
  -- Whether this hit moved any counter. False = recorded for audit only.
  counted            boolean not null default true,
  filter_reason      text check (filter_reason in
                       ('scanner', 'prefetch', 'privacy_proxy', 'head_request', 'auto_reply')),
  user_agent         text,

  -- Replies only: the Gmail id of the reply message (dedupe key — the scanner
  -- overlaps its windows), who it came from, and Gmail's short snippet.
  source_message_id  text,
  from_email         text,
  snippet            text,

  occurred_at        timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists email_engagement_events_send_idx
  on public.email_engagement_events (send_id, occurred_at desc);
create index if not exists email_engagement_events_campaign_idx
  on public.email_engagement_events (campaign_id, kind, occurred_at);
-- A reply is recorded once, however many scans see it.
create unique index if not exists email_engagement_events_source_uniq
  on public.email_engagement_events (user_id, source_message_id)
  where source_message_id is not null;

alter table public.email_engagement_events enable row level security;

drop policy if exists "Users can view own engagement events" on public.email_engagement_events;
create policy "Users can view own engagement events" on public.email_engagement_events
  for select using (user_id = auth.uid());

-- ── 4. Reply-scan cursor (lives beside the bounce cursor) ────
alter table public.bounce_scan_state
  add column if not exists replies_last_scanned_at timestamptz,
  add column if not exists replies_last_error      text,
  add column if not exists replies_recorded        integer not null default 0;

-- ── 5. Record one engagement event ───────────────────────────
/* The only path that moves an engagement counter. Called by the `track` Edge
   Function (opens, clicks) and by bounce-scan (replies).

   Row-locks the send so two simultaneous hits can't both believe they're the
   first — which is what decides whether the campaign's unique counter moves.

   p_filter_reason comes from the caller (user-agent / method classification).
   The prefetch rule is applied here because it needs sent_at: an open or click
   arriving before the send was even marked sent, or within
   p_prefetch_seconds of it, is a scanner fetching the message on delivery.

   A counted click on a send with no recorded open also marks it opened — the
   recipient plainly read it, their client just blocked images. Every major
   platform infers the open this way.

   Returns jsonb { recorded, duplicate?, counted, first, filter_reason }. */
create or replace function public.record_engagement_event(
  p_send_id           uuid,
  p_kind              text,
  p_url               text default null,
  p_user_agent        text default null,
  p_filter_reason     text default null,
  p_occurred_at       timestamptz default now(),
  p_source_message_id text default null,
  p_from_email        text default null,
  p_snippet           text default null,
  p_prefetch_seconds  integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_send     public.campaign_sends%rowtype;
  v_reason   text := p_filter_reason;
  v_counted  boolean;
  v_event_id uuid;
  v_first    boolean := false;
  v_implied_open boolean := false;
begin
  if p_kind not in ('open', 'click', 'reply') then
    return jsonb_build_object('recorded', false, 'error', 'bad_kind');
  end if;

  select * into v_send from public.campaign_sends where id = p_send_id for update;
  if not found then
    return jsonb_build_object('recorded', false, 'error', 'send_not_found');
  end if;

  if v_reason is null and p_kind in ('open', 'click') and (
       v_send.sent_at is null
       or p_occurred_at < v_send.sent_at + make_interval(secs => greatest(p_prefetch_seconds, 0))
     ) then
    v_reason := 'prefetch';
  end if;
  v_counted := v_reason is null;

  insert into public.email_engagement_events (
    user_id, send_id, campaign_id, kind, url, counted, filter_reason,
    user_agent, source_message_id, from_email, snippet, occurred_at
  )
  values (
    v_send.user_id, v_send.id, v_send.campaign_id, p_kind, left(p_url, 2000), v_counted, v_reason,
    left(p_user_agent, 500), p_source_message_id, left(p_from_email, 320), left(p_snippet, 500),
    p_occurred_at
  )
  on conflict (user_id, source_message_id) where source_message_id is not null do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('recorded', false, 'duplicate', true);
  end if;

  if not v_counted then
    if v_reason = 'auto_reply' then
      update public.campaign_sends
      set auto_replied_at = coalesce(auto_replied_at, p_occurred_at)
      where id = v_send.id;
    end if;
    return jsonb_build_object('recorded', true, 'counted', false, 'filter_reason', v_reason);
  end if;

  if p_kind = 'open' then
    v_first := v_send.first_opened_at is null;
    update public.campaign_sends
    set open_count      = open_count + 1,
        first_opened_at = coalesce(first_opened_at, p_occurred_at),
        last_opened_at  = greatest(coalesce(last_opened_at, p_occurred_at), p_occurred_at)
    where id = v_send.id;
    if v_first and v_send.campaign_id is not null then
      update public.campaigns set opened_count = opened_count + 1 where id = v_send.campaign_id;
    end if;

  elsif p_kind = 'click' then
    v_first := v_send.first_clicked_at is null;
    v_implied_open := v_send.first_opened_at is null;
    update public.campaign_sends
    set click_count      = click_count + 1,
        first_clicked_at = coalesce(first_clicked_at, p_occurred_at),
        last_clicked_at  = greatest(coalesce(last_clicked_at, p_occurred_at), p_occurred_at),
        first_opened_at  = coalesce(first_opened_at, p_occurred_at),
        last_opened_at   = greatest(coalesce(last_opened_at, p_occurred_at), p_occurred_at)
    where id = v_send.id;
    if v_send.campaign_id is not null and (v_first or v_implied_open) then
      update public.campaigns
      set clicked_count = clicked_count + case when v_first then 1 else 0 end,
          opened_count  = opened_count  + case when v_implied_open then 1 else 0 end
      where id = v_send.campaign_id;
    end if;

  else -- reply
    v_first := v_send.replied_at is null;
    update public.campaign_sends
    set reply_count = reply_count + 1,
        replied_at  = coalesce(replied_at, p_occurred_at)
    where id = v_send.id;
    if v_first and v_send.campaign_id is not null then
      update public.campaigns set replied_count = replied_count + 1 where id = v_send.campaign_id;
    end if;
  end if;

  return jsonb_build_object('recorded', true, 'counted', true, 'first', v_first,
                            'implied_open', v_implied_open);
end;
$$;

-- ── 6. Read helpers for the campaign detail page ─────────────
/* Clicks per link for one campaign. Scoped by p_user_id because it runs as
   security definer from the service-role backend. */
create or replace function public.campaign_link_stats(
  p_user_id uuid,
  p_campaign_id uuid,
  p_limit integer default 25
)
returns table (url text, clicks bigint, unique_clicks bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.url,
         count(*)                  as clicks,
         count(distinct e.send_id) as unique_clicks
  from public.email_engagement_events e
  where e.user_id = p_user_id
    and e.campaign_id = p_campaign_id
    and e.kind = 'click'
    and e.counted
    and e.url is not null
  group by e.url
  order by unique_clicks desc, clicks desc
  limit greatest(p_limit, 1);
$$;

/* Hits set aside by the filters, per kind and reason — so the UI can say
   "212 opens ignored (Apple Mail Privacy Protection)" instead of hiding them. */
create or replace function public.campaign_filtered_engagement(
  p_user_id uuid,
  p_campaign_id uuid
)
returns table (kind text, filter_reason text, hits bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.kind, e.filter_reason, count(*) as hits
  from public.email_engagement_events e
  where e.user_id = p_user_id
    and e.campaign_id = p_campaign_id
    and not e.counted
  group by e.kind, e.filter_reason;
$$;

/* Raw counted hits across the campaign (a recipient opening five times counts
   five), next to the unique-recipient counters on the campaign row. */
create or replace function public.campaign_engagement_totals(
  p_user_id uuid,
  p_campaign_id uuid
)
returns table (total_opens bigint, total_clicks bigint)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cs.open_count), 0)  as total_opens,
         coalesce(sum(cs.click_count), 0) as total_clicks
  from public.campaign_sends cs
  where cs.user_id = p_user_id
    and cs.campaign_id = p_campaign_id;
$$;

-- ── 7. Grants ────────────────────────────────────────────────
-- Security-definer functions must not be callable with the public anon key.
revoke execute on function public.record_engagement_event(uuid, text, text, text, text, timestamptz, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.campaign_link_stats(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.campaign_filtered_engagement(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.campaign_engagement_totals(uuid, uuid) from public, anon, authenticated;

grant execute on function public.record_engagement_event(uuid, text, text, text, text, timestamptz, text, text, text, integer) to service_role;
grant execute on function public.campaign_link_stats(uuid, uuid, integer) to service_role;
grant execute on function public.campaign_filtered_engagement(uuid, uuid) to service_role;
grant execute on function public.campaign_engagement_totals(uuid, uuid) to service_role;
