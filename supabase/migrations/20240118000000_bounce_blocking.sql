-- ─────────────────────────────────────────────────────────────
-- Migration: 20240118000000_bounce_blocking.sql
-- Zenviqo — Bounce & block suppression
--
-- An address that hard-bounces TWICE, or is blocked THREE times in a row,
-- must never be emailed again by that account — not by the campaign that
-- tripped it, and not by any list uploaded later.
--
-- ── Where the verdict comes from ─────────────────────────────
-- Gmail's API returns 200 for essentially every send: it accepts the message
-- and only discovers the failure when the receiving server refuses it, minutes
-- later. That failure comes back as a Delivery Status Notification (RFC 3464)
-- in the SENDER's own mailbox. The bounce-scan Edge Function reads those
-- notices, parses the machine-readable `message/delivery-status` part, and
-- calls record_delivery_failure() below with the exact values it found.
--
-- Nothing here infers a bounce. A row is only written when the DSN carried
-- `Action: failed` together with a permanent 5.x.x status, and the split is
-- the RFC 3463 class (see classify_delivery_status):
--
--   5.1.x / 5.2.x / 5.4.4   → 'bounced'  (no such mailbox / unroutable)
--   5.7.x / 5.3.0 / 5.5.0   → 'blocked'  (refused on policy or reputation)
--   4.x.x                   → neither; transient, the send just retries
--
-- ── Where the guarantee lives ────────────────────────────────
-- Suppression is enforced inside claim_due_sends(), so a suppressed address
-- cannot be claimed for delivery even if application code forgets to filter
-- it. The backend filters at schedule time too, but that is an optimization —
-- this is the wall.
-- ─────────────────────────────────────────────────────────────

-- ── 1. campaign_sends: identity + delivery outcome ───────────

-- A send can now end as 'skipped': the address was suppressed before its turn
-- came up. Distinct from 'failed' (we tried and Gmail refused) and from
-- 'canceled' (the user stopped the campaign).
alter table public.campaign_sends
  drop constraint if exists campaign_sends_status_check;
alter table public.campaign_sends
  add constraint campaign_sends_status_check
    check (status in ('scheduled', 'sending', 'sent', 'failed', 'canceled', 'skipped'));

alter table public.campaign_sends
  -- Matching a bounce back to its send is done on the address, so store it in
  -- the same normalized form the suppression list uses. Generated, so it can
  -- never drift from `email`.
  add column if not exists normalized_email text
    generated always as (lower(btrim(email))) stored,
  -- Gmail groups a bounce into the same thread as the message that caused it;
  -- `thread_id` is therefore the strongest link we get for free.
  add column if not exists gmail_thread_id text,
  -- The RFC 822 Message-ID Gmail assigned to the sent message. DSNs quote it
  -- back in In-Reply-To / References / the returned original headers, which
  -- makes this an exact match rather than a best guess.
  add column if not exists rfc822_message_id text,
  -- What we know about what happened AFTER Gmail accepted the message:
  --   'none'      → not sent (or sent before this feature existed)
  --   'pending'   → sent, still inside the grace window, no verdict yet
  --   'delivered' → grace window elapsed with no failure notice
  --   'bounced' / 'blocked' → a DSN came back and said so
  add column if not exists delivery_state text not null default 'none'
    check (delivery_state in ('none', 'pending', 'delivered', 'bounced', 'blocked')),
  add column if not exists delivery_checked_at timestamptz;

-- Suppression sweep in claim_due_sends joins scheduled rows by address.
create index if not exists campaign_sends_pending_address_idx
  on public.campaign_sends (user_id, normalized_email)
  where status = 'scheduled';
-- Bounce → send matching, by each of the three routes the scanner tries.
create index if not exists campaign_sends_rfc822_idx
  on public.campaign_sends (user_id, rfc822_message_id)
  where rfc822_message_id is not null;
create index if not exists campaign_sends_thread_idx
  on public.campaign_sends (user_id, gmail_thread_id)
  where gmail_thread_id is not null;
create index if not exists campaign_sends_sent_address_idx
  on public.campaign_sends (user_id, normalized_email, sent_at desc)
  where status = 'sent';
-- The clean-delivery sweep: "sent, still pending, old enough".
create index if not exists campaign_sends_delivery_pending_idx
  on public.campaign_sends (sent_at)
  where delivery_state = 'pending';

-- Skipped sends are an outcome worth showing next to sent/failed.
alter table public.campaigns
  add column if not exists skipped_count integer not null default 0;

-- ── 2. email_suppressions: the do-not-send list ──────────────
-- One row per (account, address). Counters here are the whole decision.
create table if not exists public.email_suppressions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  normalized_email        text not null,
  email                   text not null,

  -- Lifetime hard-bounce count. Two is the limit.
  bounce_count            integer not null default 0,
  -- Lifetime block count, kept for reporting.
  block_count             integer not null default 0,
  -- Blocks since the last CONFIRMED clean delivery. Three in a row is the
  -- limit; one delivery that draws no failure notice puts this back to 0.
  consecutive_block_count integer not null default 0,

  status                  text not null default 'active'
                            check (status in ('active', 'suppressed')),
  -- Why it was suppressed; null while still active.
  reason                  text check (reason in ('bounced', 'blocked', 'manual')),

  first_failure_at        timestamptz,
  last_failure_at         timestamptz,
  last_bounce_at          timestamptz,
  last_block_at           timestamptz,
  suppressed_at           timestamptz,
  -- Verbatim evidence for the most recent failure, so a user asking "why is
  -- this address suppressed?" gets the receiving server's own words.
  last_status_code        text,
  last_diagnostic         text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (user_id, normalized_email)
);

create index if not exists email_suppressions_user_idx
  on public.email_suppressions (user_id, status);
create index if not exists email_suppressions_lookup_idx
  on public.email_suppressions (user_id, normalized_email)
  where status = 'suppressed';

drop trigger if exists email_suppressions_updated_at on public.email_suppressions;
create trigger email_suppressions_updated_at
  before update on public.email_suppressions
  for each row execute function public.update_updated_at_column();

-- ── 3. email_delivery_events: the audit trail ────────────────
-- Every parsed DSN lands here before any counter moves. The unique key is what
-- makes the scanner safe to re-run: the same bounce message seen on a second
-- pass conflicts and is ignored, so an address is never charged twice for one
-- failure.
create table if not exists public.email_delivery_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  send_id            uuid references public.campaign_sends(id) on delete set null,
  campaign_id        uuid references public.campaigns(id) on delete set null,

  normalized_email   text not null,
  email              text not null,

  kind               text not null check (kind in ('bounced', 'blocked')),
  -- RFC 3463 enhanced code, e.g. '5.1.1'. Never null — a failure we could not
  -- read a status code from is not recorded at all.
  status_code        text not null,
  -- 'failed' from the DSN's Action: field.
  action             text,
  -- The receiving server's Diagnostic-Code, verbatim.
  diagnostic         text,
  -- Gmail id of the BOUNCE message. Together with the address this dedupes a
  -- notice that names several failed recipients.
  source_message_id  text not null,
  -- How the bounce was tied to a send: 'message_id' | 'thread_id' | 'address'.
  match_method       text,

  reported_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),

  unique (user_id, source_message_id, normalized_email)
);

create index if not exists email_delivery_events_user_idx
  on public.email_delivery_events (user_id, reported_at desc);
create index if not exists email_delivery_events_address_idx
  on public.email_delivery_events (user_id, normalized_email, reported_at desc);
create index if not exists email_delivery_events_campaign_idx
  on public.email_delivery_events (campaign_id);

-- ── 4. Suppression state on the imported sheet rows ──────────
-- The request was that the sheet itself carries the mark. These columns are
-- what the list view renders, and they are written for EVERY list the address
-- appears in, including lists uploaded before the failure happened.
alter table public.recipients
  add column if not exists delivery_state text not null default 'ok'
    check (delivery_state in ('ok', 'bounced', 'blocked')),
  add column if not exists bounce_count integer not null default 0,
  add column if not exists block_count integer not null default 0,
  add column if not exists suppressed_at timestamptz,
  add column if not exists last_failure_code text,
  add column if not exists last_failure_at timestamptz;

create index if not exists recipients_suppressed_idx
  on public.recipients (list_id)
  where suppressed_at is not null;
-- Fanning a suppression out across every list the address is in.
create index if not exists recipients_user_email_idx
  on public.recipients (user_id, normalized_email);

alter table public.recipient_lists
  add column if not exists suppressed_rows integer not null default 0;

-- ── 5. Per-account scan cursor ───────────────────────────────
-- Where the last bounce scan got to, so each pass reads a small window of new
-- mail instead of the whole mailbox. Also the place a missing gmail.readonly
-- grant is recorded, so the UI can ask for a reconnect.
create table if not exists public.bounce_scan_state (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  -- Only messages newer than this are fetched. Deliberately rewound by an
  -- overlap window on each pass (dedupe makes overlap free).
  last_scanned_at    timestamptz,
  last_run_at        timestamptz,
  last_error         text,
  -- 'ok' | 'missing_scope' | 'error'
  last_status        text not null default 'ok',
  messages_scanned   integer not null default 0,
  failures_recorded  integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists bounce_scan_state_updated_at on public.bounce_scan_state;
create trigger bounce_scan_state_updated_at
  before update on public.bounce_scan_state
  for each row execute function public.update_updated_at_column();

-- ── 6. RLS ───────────────────────────────────────────────────
alter table public.email_suppressions   enable row level security;
alter table public.email_delivery_events enable row level security;
alter table public.bounce_scan_state    enable row level security;

create policy "Users can view own suppressions" on public.email_suppressions
  for select using (user_id = auth.uid());
create policy "Users can update own suppressions" on public.email_suppressions
  for update using (user_id = auth.uid());
create policy "Users can insert own suppressions" on public.email_suppressions
  for insert with check (user_id = auth.uid());
create policy "Users can delete own suppressions" on public.email_suppressions
  for delete using (user_id = auth.uid());

create policy "Users can view own delivery events" on public.email_delivery_events
  for select using (user_id = auth.uid());

create policy "Users can view own scan state" on public.bounce_scan_state
  for select using (user_id = auth.uid());

-- ── 7. Classification ────────────────────────────────────────
/* The single place an enhanced status code becomes a verdict. Returns
   'bounced', 'blocked', or null when the code is not a permanent failure we
   act on. Called by record_delivery_failure, and exposed so the same rule can
   be checked from SQL rather than reimplemented.

   Codes follow RFC 3463 (class.subject.detail):
     5.1.x  bad destination mailbox   → bounced
     5.2.x  mailbox full/disabled     → bounced
     5.4.4  unable to route           → bounced
     5.7.x  security / policy refusal → blocked  (spam block, blocklist, DMARC)
     5.3.0  system refused the message→ blocked
     5.5.0  protocol refusal          → blocked
   Anything 4.x.x is transient by definition and returns null: the send is
   retried, no strike is recorded. A 5.x.x we do not recognize is treated as a
   bounce, because permanent-and-undeliverable is what class 5 means.

   One carve-out: 5.4.5 is excluded. RFC 3463 calls it "mail system
   congestion", and it is the code Gmail returns when the SENDING account has
   exhausted its daily quota — a problem with our side of the exchange, not
   with the address. Left in the bounce bucket it would punish a recipient for
   the sender hitting a limit, and two busy days would blacklist a perfectly
   good address forever. It is never a strike; the send simply retries. */
create or replace function public.classify_delivery_status(p_status_code text)
returns text
language plpgsql
immutable
as $$
declare
  v_code text := btrim(coalesce(p_status_code, ''));
begin
  if v_code !~ '^[45]\.\d+\.\d+$' then
    return null;
  end if;

  -- Transient. The receiving server is asking us to try again, not refusing.
  if v_code like '4.%' then
    return null;
  end if;

  -- Congestion / sending-quota exhaustion. Describes the sender's system, not
  -- the recipient's address, so it can never count against an address.
  if v_code = '5.4.5' then
    return null;
  end if;

  if v_code like '5.7.%' or v_code = '5.3.0' or v_code = '5.5.0' then
    return 'blocked';
  end if;

  return 'bounced';
end;
$$;

-- ── 8. Fan a failure out to the sheets ───────────────────────
/* Writes what we now know about an address onto every recipient row carrying
   it, across every list this account has uploaded, and refreshes each affected
   list's suppressed_rows tally.

   Called on EVERY recorded failure, not only on the one that crosses the
   threshold. That matters: an address sitting on its first bounce is exactly
   the thing a user wants to see in the sheet before it disappears from the
   next campaign, and showing it only after it is already dead is showing it too
   late. The two states stay distinguishable — `delivery_state` plus the counts
   say "this failed", `suppressed_at` says "and it will never be sent again" —
   so the UI can render a warning and a block differently.

   p_suppressed is what separates them. Until it is true, suppressed_at stays
   null and the row is still mailable. */
create or replace function public.mark_recipient_failure(
  p_user_id uuid,
  p_normalized_email text,
  p_kind text,
  p_status_code text,
  p_failed_at timestamptz,
  p_bounce_count integer,
  p_block_count integer,
  p_suppressed boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.recipients r
  set delivery_state    = case when p_kind = 'blocked' then 'blocked' else 'bounced' end,
      bounce_count      = p_bounce_count,
      block_count       = p_block_count,
      last_failure_code = p_status_code,
      last_failure_at   = p_failed_at,
      -- Keep the FIRST suppression instant: it is when the address stopped
      -- being mailable, and a later failure on another list must not reset it.
      suppressed_at     = case
                            when p_suppressed then coalesce(r.suppressed_at, p_failed_at)
                            else r.suppressed_at
                          end
  where r.user_id = p_user_id
    and r.normalized_email = p_normalized_email;

  -- Only a suppression changes a list's blocked-row count, so skip the
  -- recount entirely for a first-strike failure.
  if p_suppressed then
    update public.recipient_lists l
    set suppressed_rows = sub.n,
        updated_at = now()
    from (
      select r.list_id, count(*) as n
      from public.recipients r
      where r.user_id = p_user_id and r.suppressed_at is not null
      group by r.list_id
    ) sub
    where l.id = sub.list_id
      and l.user_id = p_user_id
      and l.suppressed_rows is distinct from sub.n;
  end if;
end;
$$;

-- ── 9. Record one verified failure ───────────────────────────
/* The only path by which a bounce or block is counted. Call it once per
   (bounce message, failed recipient) pair with values read straight out of the
   DSN; it decides everything else.

   Returns jsonb describing what happened:
     { recorded, duplicate, kind, bounce_count, consecutive_block_count,
       suppressed, reason, canceled_sends }

   Idempotent: the unique key on email_delivery_events means re-scanning the
   same notice is a no-op, so the scanner can overlap its windows freely. */
create or replace function public.record_delivery_failure(
  p_user_id uuid,
  p_source_message_id text,
  p_recipient_email text,
  p_status_code text,
  p_diagnostic text default null,
  p_action text default 'failed',
  p_send_id uuid default null,
  p_campaign_id uuid default null,
  p_match_method text default null,
  p_reported_at timestamptz default now(),
  p_bounce_threshold integer default 2,
  p_block_threshold integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := btrim(coalesce(p_recipient_email, ''));
  v_norm     text := lower(btrim(coalesce(p_recipient_email, '')));
  v_kind     text;
  v_event_id uuid;
  v_sup      public.email_suppressions%rowtype;
  v_suppress boolean := false;
  v_reason   text;
  v_canceled integer := 0;
begin
  if v_norm = '' then
    return jsonb_build_object('recorded', false, 'error', 'missing_recipient');
  end if;

  -- The verdict, derived only from the code the receiving server sent.
  v_kind := public.classify_delivery_status(p_status_code);
  if v_kind is null then
    return jsonb_build_object('recorded', false, 'error', 'not_a_permanent_failure',
                              'status_code', p_status_code);
  end if;

  -- A DSN part that is not reporting a failure (Action: delivered / relayed /
  -- expanded) never counts, whatever its status code says.
  if p_action is not null and lower(btrim(p_action)) <> 'failed' then
    return jsonb_build_object('recorded', false, 'error', 'action_not_failed',
                              'action', p_action);
  end if;

  -- Audit first. The conflict here is the dedupe.
  insert into public.email_delivery_events (
    user_id, send_id, campaign_id, normalized_email, email, kind,
    status_code, action, diagnostic, source_message_id, match_method, reported_at
  )
  values (
    p_user_id, p_send_id, p_campaign_id, v_norm, v_email, v_kind,
    btrim(p_status_code), p_action, p_diagnostic, p_source_message_id,
    p_match_method, p_reported_at
  )
  on conflict (user_id, source_message_id, normalized_email) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('recorded', false, 'duplicate', true, 'kind', v_kind);
  end if;

  -- Stamp the send this notice was traced to, so the campaign view can show
  -- which recipients bounced rather than just "sent".
  if p_send_id is not null then
    update public.campaign_sends
    set delivery_state = v_kind,
        delivery_checked_at = now(),
        error = coalesce(nullif(btrim(p_status_code), ''), v_kind) ||
                case when p_diagnostic is null then '' else ': ' || left(p_diagnostic, 300) end,
        updated_at = now()
    where id = p_send_id;
  end if;

  -- Move the counters.
  insert into public.email_suppressions (
    user_id, normalized_email, email,
    bounce_count, block_count, consecutive_block_count,
    first_failure_at, last_failure_at,
    last_bounce_at, last_block_at,
    last_status_code, last_diagnostic
  )
  values (
    p_user_id, v_norm, v_email,
    case when v_kind = 'bounced' then 1 else 0 end,
    case when v_kind = 'blocked' then 1 else 0 end,
    case when v_kind = 'blocked' then 1 else 0 end,
    p_reported_at, p_reported_at,
    case when v_kind = 'bounced' then p_reported_at end,
    case when v_kind = 'blocked' then p_reported_at end,
    btrim(p_status_code), p_diagnostic
  )
  on conflict (user_id, normalized_email) do update
  set bounce_count = email_suppressions.bounce_count
                     + case when v_kind = 'bounced' then 1 else 0 end,
      block_count  = email_suppressions.block_count
                     + case when v_kind = 'blocked' then 1 else 0 end,
      -- A bounce is not a block: it neither extends nor breaks the block
      -- streak. Only a confirmed clean delivery clears it.
      consecutive_block_count = email_suppressions.consecutive_block_count
                     + case when v_kind = 'blocked' then 1 else 0 end,
      last_failure_at  = greatest(email_suppressions.last_failure_at, p_reported_at),
      last_bounce_at   = case when v_kind = 'bounced'
                              then greatest(coalesce(email_suppressions.last_bounce_at, p_reported_at), p_reported_at)
                              else email_suppressions.last_bounce_at end,
      last_block_at    = case when v_kind = 'blocked'
                              then greatest(coalesce(email_suppressions.last_block_at, p_reported_at), p_reported_at)
                              else email_suppressions.last_block_at end,
      last_status_code = btrim(p_status_code),
      last_diagnostic  = p_diagnostic,
      email            = coalesce(nullif(email_suppressions.email, ''), v_email)
  returning * into v_sup;

  -- The thresholds. Two hard bounces ever, or three blocks with no clean
  -- delivery in between.
  if v_sup.status <> 'suppressed' then
    if v_sup.bounce_count >= p_bounce_threshold then
      v_suppress := true;
      v_reason := 'bounced';
    elsif v_sup.consecutive_block_count >= p_block_threshold then
      v_suppress := true;
      v_reason := 'blocked';
    end if;
  end if;

  -- Mark the sheet regardless of whether this failure was the last straw, so a
  -- first bounce is visible to the user rather than silent until the address
  -- dies.
  perform public.mark_recipient_failure(
    p_user_id, v_norm, v_kind, btrim(p_status_code), p_reported_at,
    v_sup.bounce_count, v_sup.block_count, v_suppress
  );

  if v_suppress then
    update public.email_suppressions
    set status = 'suppressed',
        reason = v_reason,
        suppressed_at = coalesce(suppressed_at, p_reported_at)
    where id = v_sup.id;

    -- Pull the address out of every queue it is still sitting in. Without
    -- this, sends already booked for later today would go out after the
    -- address had been suppressed.
    with cleared as (
      update public.campaign_sends
      set status = 'skipped',
          error = 'suppressed_' || v_reason,
          locked_at = null,
          updated_at = now()
      where user_id = p_user_id
        and normalized_email = v_norm
        and status = 'scheduled'
      returning 1
    )
    select count(*) into v_canceled from cleared;
  end if;

  return jsonb_build_object(
    'recorded', true,
    'duplicate', false,
    'kind', v_kind,
    'bounce_count', v_sup.bounce_count,
    'block_count', v_sup.block_count,
    'consecutive_block_count', v_sup.consecutive_block_count,
    'suppressed', v_suppress,
    'reason', v_reason,
    'canceled_sends', v_canceled
  );
end;
$$;

-- ── 10. Confirm clean deliveries ─────────────────────────────
/* A send that has been out for longer than the grace window without drawing a
   failure notice is treated as delivered. That is the event which resets a
   block streak — "blocked 3 times in a row" means three blocks with no
   successful delivery between them.

   The reset is guarded on last_block_at: an address whose most recent block
   happened AFTER the send being confirmed keeps its streak, so confirming an
   old send can never erase a newer block. */
create or replace function public.confirm_clean_deliveries(
  p_grace interval default '24 hours',
  p_limit integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed integer := 0;
  v_reset integer := 0;
begin
  with due as (
    select id, user_id, normalized_email, sent_at
    from public.campaign_sends
    where delivery_state = 'pending'
      and status = 'sent'
      and sent_at is not null
      and sent_at < now() - p_grace
    order by sent_at
    limit p_limit
  ),
  marked as (
    update public.campaign_sends cs
    set delivery_state = 'delivered',
        delivery_checked_at = now(),
        updated_at = now()
    from due
    where cs.id = due.id
    returning cs.user_id, cs.normalized_email, cs.sent_at
  ),
  reset as (
    update public.email_suppressions s
    set consecutive_block_count = 0
    from (select distinct user_id, normalized_email, max(sent_at) as sent_at
          from marked group by user_id, normalized_email) m
    where s.user_id = m.user_id
      and s.normalized_email = m.normalized_email
      and s.status = 'active'
      and s.consecutive_block_count > 0
      -- Only if nothing was blocked after the delivery we just confirmed.
      and (s.last_block_at is null or s.last_block_at < m.sent_at)
    returning 1
  )
  select (select count(*) from marked), (select count(*) from reset)
  into v_confirmed, v_reset;

  return jsonb_build_object('confirmed', v_confirmed, 'streaks_reset', v_reset);
end;
$$;

-- ── 11. Manual suppress / release ────────────────────────────
/* Lets a user add an address by hand, and lift a suppression they believe was
   wrong.

   Releasing zeroes the counters and clears the recorded diagnostics: a user who
   says an address is fine should get a genuinely clean slate, not one that
   re-suppresses on its very next hiccup. The audit trail in
   email_delivery_events is untouched, so the history is still there — it just
   stops counting. If the address really is dead it will bounce twice again and
   come straight back. */
create or replace function public.set_suppression(
  p_user_id uuid,
  p_email text,
  p_suppressed boolean,
  p_reason text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_bounces integer;
  v_blocks integer;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_email');
  end if;

  if p_suppressed then
    insert into public.email_suppressions (
      user_id, normalized_email, email, status, reason,
      first_failure_at, last_failure_at, suppressed_at
    )
    values (p_user_id, v_norm, btrim(p_email), 'suppressed',
            coalesce(p_reason, 'manual'), now(), now(), now())
    on conflict (user_id, normalized_email) do update
    set status = 'suppressed',
        reason = coalesce(email_suppressions.reason, coalesce(p_reason, 'manual')),
        suppressed_at = coalesce(email_suppressions.suppressed_at, now())
    returning id, bounce_count, block_count into v_id, v_bounces, v_blocks;

    update public.campaign_sends
    set status = 'skipped',
        error = 'suppressed_' || coalesce(p_reason, 'manual'),
        locked_at = null,
        updated_at = now()
    where user_id = p_user_id and normalized_email = v_norm and status = 'scheduled';

    perform public.mark_recipient_failure(
      p_user_id, v_norm,
      case when coalesce(p_reason, 'manual') = 'blocked' then 'blocked' else 'bounced' end,
      null, now(), coalesce(v_bounces, 0), coalesce(v_blocks, 0), true
    );
  else
    update public.email_suppressions
    set status = 'active',
        reason = null,
        suppressed_at = null,
        bounce_count = 0,
        block_count = 0,
        consecutive_block_count = 0,
        last_status_code = null,
        last_diagnostic = null
    where user_id = p_user_id and normalized_email = v_norm
    returning id into v_id;

    update public.recipients
    set delivery_state = 'ok',
        suppressed_at = null,
        bounce_count = 0,
        block_count = 0,
        last_failure_code = null,
        last_failure_at = null
    where user_id = p_user_id and normalized_email = v_norm;

    update public.recipient_lists l
    set suppressed_rows = coalesce(sub.n, 0), updated_at = now()
    from (
      select l2.id as list_id,
             count(r.id) filter (where r.suppressed_at is not null) as n
      from public.recipient_lists l2
      left join public.recipients r on r.list_id = l2.id
      where l2.user_id = p_user_id
      group by l2.id
    ) sub
    where l.id = sub.list_id and l.suppressed_rows is distinct from coalesce(sub.n, 0);
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'suppressed', p_suppressed);
end;
$$;

-- ── 12. Enforce suppression in the claim path ────────────────
/* Same as 20240117000000's version, with one addition: before anything is
   claimed, every scheduled send addressed to a suppressed address is taken out
   of the queue. This is the guarantee — application code can forget to filter,
   a list can be uploaded after the address was suppressed, a campaign can be
   rescheduled — and a suppressed address still cannot be claimed for delivery,
   because the only function that hands work to the sender removes it first. */
create or replace function public.claim_due_sends(
  p_max_per_user integer default 1,
  p_lock_ttl interval default '5 minutes'
)
returns setof public.campaign_sends
language plpgsql
as $$
declare
  v_next_slot timestamptz := date_trunc('minute', now()) + interval '1 minute';
begin
  -- Reclaim rows stuck in 'sending' from a crashed/timed-out pass so
  -- they're eligible again instead of stranded forever.
  update public.campaign_sends
  set status = 'scheduled', locked_at = null
  where status = 'sending' and locked_at < now() - p_lock_ttl;

  -- Drop suppressed addresses out of the queue before the claim runs.
  update public.campaign_sends cs
  set status = 'skipped',
      error = 'suppressed_' || coalesce(s.reason, 'suppressed'),
      locked_at = null,
      updated_at = now()
  from public.email_suppressions s
  where s.user_id = cs.user_id
    and s.normalized_email = cs.normalized_email
    and s.status = 'suppressed'
    and cs.status = 'scheduled';

  return query
  with due as (
    select cs.id,
           row_number() over (
             partition by cs.user_id order by cs.scheduled_at asc, cs.id asc
           ) as rn
    from public.campaign_sends cs
    join public.campaigns c on c.id = cs.campaign_id
    where cs.status = 'scheduled'
      and cs.scheduled_at <= now()
      and c.status in ('scheduled', 'sending')
  ),
  locked as (
    select due.id, due.rn
    from due
    join public.campaign_sends cs on cs.id = due.id
    where cs.status = 'scheduled'
    for update of cs skip locked
  ),
  overflow as (
    update public.campaign_sends cs
    set scheduled_at = v_next_slot,
        reschedule_count = cs.reschedule_count + 1,
        updated_at = now()
    from locked
    where locked.id = cs.id and locked.rn > p_max_per_user
  ),
  claimed as (
    update public.campaign_sends cs
    set status = 'sending', locked_at = now(), updated_at = now()
    from locked
    where locked.id = cs.id and locked.rn <= p_max_per_user
    returning cs.*
  )
  select * from claimed;
end;
$$;

-- ── 13. Progress accounting with skipped sends ───────────────
/* 'skipped' is terminal, exactly like sent and failed. Without counting it as
   such a campaign whose remaining recipients were all suppressed would sit at
   'sending' forever, because nothing would ever clear the last rows. */
create or replace function public.refresh_campaign_progress(p_campaign_id uuid)
returns void
language plpgsql
as $$
declare
  v_sent integer;
  v_failed integer;
  v_skipped integer;
  v_total integer;
  v_remaining integer;
begin
  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status = 'skipped'),
    count(*),
    count(*) filter (where status in ('scheduled', 'sending'))
  into v_sent, v_failed, v_skipped, v_total, v_remaining
  from public.campaign_sends
  where campaign_id = p_campaign_id;

  update public.campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      skipped_count = v_skipped,
      status = case
        when v_remaining = 0 and v_total > 0 and status not in ('canceled', 'paused')
          then 'completed'
        when v_remaining > 0 and (v_sent + v_failed + v_skipped) > 0 and status = 'scheduled'
          then 'sending'
        else status
      end,
      started_at = case
        when started_at is null and (v_sent + v_failed) > 0 then now()
        else started_at
      end,
      updated_at = now()
  where id = p_campaign_id;
end;
$$;

-- ── 14. Mark a freshly imported list ─────────────────────────
/* Stamps suppression state onto a list that was just uploaded.

   mark_recipient_failure() handles the other direction — an address failing
   today marks every list it already appears in. This is the case where
   the list arrives second: a user uploads a new sheet that happens to contain
   an address suppressed weeks ago, and expects to see it flagged straight away
   rather than after its first skipped send.

   One statement, joined on the suppression list, so importing 50,000 rows
   costs a single indexed pass. */
create or replace function public.sync_list_suppressions(
  p_user_id uuid,
  p_list_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marked integer := 0;
begin
  with marked as (
    update public.recipients r
    set delivery_state    = case when s.reason = 'blocked' then 'blocked' else 'bounced' end,
        bounce_count      = s.bounce_count,
        block_count       = s.block_count,
        last_failure_code = s.last_status_code,
        last_failure_at   = s.last_failure_at,
        suppressed_at     = coalesce(s.suppressed_at, now())
    from public.email_suppressions s
    where r.list_id = p_list_id
      and r.user_id = p_user_id
      and s.user_id = p_user_id
      and s.normalized_email = r.normalized_email
      and s.status = 'suppressed'
      and r.suppressed_at is null
    returning 1
  )
  select count(*) into v_marked from marked;

  if v_marked > 0 then
    update public.recipient_lists
    set suppressed_rows = (
          select count(*) from public.recipients
          where list_id = p_list_id and suppressed_at is not null
        ),
        updated_at = now()
    where id = p_list_id and user_id = p_user_id;
  end if;

  return v_marked;
end;
$$;

-- ── 14. Grants ───────────────────────────────────────────────
grant execute on function public.classify_delivery_status(text) to service_role;
grant execute on function public.mark_recipient_failure(uuid, text, text, text, timestamptz, integer, integer, boolean) to service_role;
grant execute on function public.record_delivery_failure(uuid, text, text, text, text, text, uuid, uuid, text, timestamptz, integer, integer) to service_role;
grant execute on function public.confirm_clean_deliveries(interval, integer) to service_role;
grant execute on function public.set_suppression(uuid, text, boolean, text) to service_role;
grant execute on function public.sync_list_suppressions(uuid, uuid) to service_role;
grant execute on function public.claim_due_sends(integer, interval) to service_role;
grant execute on function public.refresh_campaign_progress(uuid) to service_role;
