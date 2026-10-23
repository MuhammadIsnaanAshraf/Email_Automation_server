// ─────────────────────────────────────────────────────────────
// Zenviqo — Bounce & block scanner (Supabase Edge Function)
//
// Gmail's send API returns 200 for almost everything: it accepts the message
// and only finds out it was refused when the receiving server says so, minutes
// to hours later. That refusal comes back as a Delivery Status Notification in
// the SENDING account's own mailbox. This function is what reads them.
//
// Each run:
//   1. Confirms clean deliveries — any send that has been out longer than the
//      grace window with no failure notice is marked delivered, which is the
//      event that resets an address's consecutive-block streak.
//   2. For every account with recent sends, searches its mailbox for candidate
//      failure notices since the last scan (with an overlap window), pulls the
//      raw MIME, and parses the machine-readable delivery-status report.
//   3. For each reported recipient, confirms WE actually sent to that address
//      from this account, then hands the parsed facts to record_delivery_failure,
//      which owns all counting and suppression.
//
// The same pass also detects REPLIES (step 4): inbound mail in the Gmail thread
// of one of our sends. It runs after the bounce work with its own cursor and
// its own error handling, so a reply-scan problem can never cost a bounce.
//
// What it will not do: conclude anything from a subject line, a sender address,
// or the human-readable part of a notice. A message with no parseable report is
// counted as unread and skipped. Suppression is permanent, so the bar for it is
// evidence, not likelihood.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2'
import { decryptToken, encryptToken } from '../send-tick/crypto.ts'
import { refreshAccessToken, ConnectionError } from '../send-tick/gmail.ts'
import { parseDsn, classify } from './dsn.ts'
import {
  listBounceCandidates,
  listMessages,
  getMessageMetadata,
  getRawMessage,
  GmailReadError,
  GMAIL_READ_SCOPE,
} from './gmailRead.ts'
import {
  buildReplyQuery,
  isAutoReply,
  isDeliveryNotice,
  parseAddress,
  pickSendForReply,
  REPLY_METADATA_HEADERS,
  type ThreadSend,
} from './replies.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const TOKEN_ENCRYPTION_KEY = Deno.env.get('TOKEN_ENCRYPTION_KEY')!
// Its own secret if one is set, otherwise the send tick's — so this can be
// wired up without rotating anything.
const TICK_SECRET = Deno.env.get('BOUNCE_SCAN_SECRET') ?? Deno.env.get('SEND_TICK_SECRET')!

const TOKEN_EXPIRY_BUFFER_MS = 60_000

/* How long a send sits in 'pending' before silence is taken as delivery.
   Most hard bounces return within seconds and nearly all within an hour;
   24h is generous on purpose, because this window only gates the RESET of a
   block streak — being slow to reset is harmless, being quick to reset would
   let a genuinely blocked address keep getting retried. */
const DELIVERY_GRACE_HOURS = Number(Deno.env.get('BOUNCE_GRACE_HOURS') ?? '24')

/* Each pass re-reads a little before the last cursor. Gmail's `after:` search
   resolves to whole days and messages can be indexed slightly out of order, so
   overlapping guarantees nothing falls through a seam. Re-reading is free:
   email_delivery_events' unique key makes a repeated notice a no-op. */
const SCAN_OVERLAP_MINUTES = Number(Deno.env.get('BOUNCE_SCAN_OVERLAP_MINUTES') ?? '90')

/* First scan for an account looks back this far, so bounces from campaigns
   that went out before the feature was switched on still get counted. */
const INITIAL_LOOKBACK_DAYS = Number(Deno.env.get('BOUNCE_INITIAL_LOOKBACK_DAYS') ?? '7')

/* How far back a bounce may reach to claim a send by address alone. A notice
   arriving two weeks after the send is almost certainly about a later message. */
const MATCH_LOOKBACK_DAYS = Number(Deno.env.get('BOUNCE_MATCH_LOOKBACK_DAYS') ?? '14')

const MAX_MESSAGES_PER_USER = Number(Deno.env.get('BOUNCE_MAX_MESSAGES_PER_USER') ?? '60')
const MAX_USERS_PER_PASS = Number(Deno.env.get('BOUNCE_MAX_USERS_PER_PASS') ?? '25')
const USER_CONCURRENCY = Number(Deno.env.get('BOUNCE_USER_CONCURRENCY') ?? '5')

/* Reply detection. Listing is cheap (ids + thread ids, 100 per call) and is
   matched against our sends locally, so only messages that really sit in one
   of our threads cost a metadata fetch. */
const REPLY_TRACKING_ENABLED = (Deno.env.get('REPLY_TRACKING_ENABLED') ?? 'true') !== 'false'
const REPLY_MAX_LISTED_PER_USER = Number(Deno.env.get('REPLY_MAX_LISTED_PER_USER') ?? '500')
const REPLY_MAX_FETCHED_PER_USER = Number(Deno.env.get('REPLY_MAX_FETCHED_PER_USER') ?? '100')
const REPLY_INITIAL_LOOKBACK_DAYS = Number(Deno.env.get('REPLY_INITIAL_LOOKBACK_DAYS') ?? '7')

console.log('[bounce-scan] module init; env present:', {
  SUPABASE_URL: !!SUPABASE_URL,
  SERVICE_ROLE: !!SERVICE_ROLE,
  GOOGLE_CLIENT_ID: !!GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: !!GOOGLE_CLIENT_SECRET,
  TOKEN_ENCRYPTION_KEY: !!TOKEN_ENCRYPTION_KEY,
  TICK_SECRET: !!TICK_SECRET,
})

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

interface UserScanResult {
  userId: string
  status: 'ok' | 'missing_scope' | 'error' | 'skipped'
  scanned: number
  parsed: number
  recorded: number
  duplicates: number
  suppressed: number
  unmatched: number
  replies: number
  autoReplies: number
  error?: string
}

// ── Access token, same cache discipline as the send tick ─────
async function getAccessToken(userId: string): Promise<{ token: string; scopes: string[] }> {
  const { data: conn } = await supabase
    .from('google_connections')
    .select('refresh_token, access_token, token_expiry, status, scopes')
    .eq('user_id', userId)
    .single()

  const scopes: string[] = conn?.scopes || []
  const expiry = conn?.token_expiry ? new Date(conn.token_expiry).getTime() : 0
  const cached = conn?.access_token ? await decryptToken(conn.access_token, TOKEN_ENCRYPTION_KEY) : null

  if (cached && expiry - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return { token: cached, scopes }
  }

  const refreshToken = await decryptToken(conn?.refresh_token ?? null, TOKEN_ENCRYPTION_KEY)
  if (!refreshToken) throw new ConnectionError('No Gmail connection on file.', 'no_refresh_token')

  const refreshed = await refreshAccessToken(refreshToken, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  await supabase
    .from('google_connections')
    .update({
      access_token: await encryptToken(refreshed.accessToken, TOKEN_ENCRYPTION_KEY),
      token_expiry: new Date(refreshed.expiresAt).toISOString(),
      status: 'connected',
      last_error: null,
      ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)

  // Prefer what Google just told us over the stored list, which may still be
  // the optimistic one written at sign-in.
  return { token: refreshed.accessToken, scopes: refreshed.scopes ?? scopes }
}

// ── Tying a report back to the send that caused it ───────────

interface SendMatch {
  id: string
  campaign_id: string
  method: 'message_id' | 'thread_id' | 'address'
}

/* Three routes, strongest first. All three require the address to match the
   one the DSN named, so a thread or message-id coincidence can never attribute
   a bounce to the wrong recipient.

   Attribution is NOT what makes a bounce real — the DSN already established
   that. What a match buys is (a) the campaign view showing which recipient
   bounced, and (b) proof that this account actually sent to the address, which
   is the gate below. A notice about an address we never mailed is ignored:
   users send personal mail from the same Gmail account, and their private
   bounces are none of this system's business. */
async function matchSend(
  userId: string,
  recipient: string,
  messageIds: string[],
  threadId: string,
  reportedAt: Date
): Promise<SendMatch | null> {
  const since = new Date(reportedAt.getTime() - MATCH_LOOKBACK_DAYS * 86400_000).toISOString()

  if (messageIds.length) {
    const { data } = await supabase
      .from('campaign_sends')
      .select('id, campaign_id')
      .eq('user_id', userId)
      .eq('normalized_email', recipient)
      .in('rfc822_message_id', messageIds)
      .limit(1)
    if (data?.length) return { ...data[0], method: 'message_id' }
  }

  if (threadId) {
    const { data } = await supabase
      .from('campaign_sends')
      .select('id, campaign_id')
      .eq('user_id', userId)
      .eq('normalized_email', recipient)
      .eq('gmail_thread_id', threadId)
      .limit(1)
    if (data?.length) return { ...data[0], method: 'thread_id' }
  }

  // Last resort: the most recent message this account actually sent to the
  // address before the notice arrived.
  const { data } = await supabase
    .from('campaign_sends')
    .select('id, campaign_id')
    .eq('user_id', userId)
    .eq('normalized_email', recipient)
    .eq('status', 'sent')
    .gte('sent_at', since)
    .lte('sent_at', reportedAt.toISOString())
    .order('sent_at', { ascending: false })
    .limit(1)
  if (data?.length) return { ...data[0], method: 'address' }

  return null
}

// ── One account's pass ───────────────────────────────────────
async function scanUser(userId: string): Promise<UserScanResult> {
  const result: UserScanResult = {
    userId,
    status: 'ok',
    scanned: 0,
    parsed: 0,
    recorded: 0,
    duplicates: 0,
    suppressed: 0,
    unmatched: 0,
    replies: 0,
    autoReplies: 0,
  }

  const { data: state } = await supabase
    .from('bounce_scan_state')
    .select('last_scanned_at')
    .eq('user_id', userId)
    .maybeSingle()

  const cursor = state?.last_scanned_at
    ? new Date(state.last_scanned_at).getTime() - SCAN_OVERLAP_MINUTES * 60_000
    : Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000
  // Gmail's `after:` is exclusive at day resolution; a second of slack costs
  // nothing because duplicates are free.
  const afterEpochSeconds = Math.floor(cursor / 1000)

  // The instant this pass covers up to. Captured BEFORE any I/O so a notice
  // that lands mid-scan is picked up next time rather than skipped.
  const passStartedAt = new Date()

  let accessToken: string
  let scopes: string[]
  try {
    const got = await getAccessToken(userId)
    accessToken = got.token
    scopes = got.scopes
  } catch (err) {
    result.status = 'error'
    result.error = String(err)
    await writeState(userId, null, result)
    return result
  }

  // Reading the mailbox needs a scope the app did not originally request.
  // Accounts that connected before it was added must re-consent; say so
  // explicitly rather than failing with an opaque 403 every minute.
  if (scopes.length && !scopes.includes(GMAIL_READ_SCOPE)) {
    result.status = 'missing_scope'
    result.error = 'Gmail read access not granted; reconnect required.'
    await writeState(userId, null, result)
    return result
  }

  let candidates
  try {
    candidates = await listBounceCandidates(accessToken, afterEpochSeconds, MAX_MESSAGES_PER_USER)
  } catch (err) {
    const missingScope = err instanceof GmailReadError && err.code === 'missing_scope'
    result.status = missingScope ? 'missing_scope' : 'error'
    result.error = String(err)
    await writeState(userId, null, result)
    return result
  }

  const touchedCampaigns = new Set<string>()

  for (const ref of candidates) {
    let message
    try {
      message = await getRawMessage(accessToken, ref.id)
    } catch (err) {
      console.warn('[bounce-scan] could not fetch message', ref.id, String(err))
      continue
    }
    result.scanned++

    const parsed = parseDsn(message.raw)
    // No machine-readable report → no verdict. This is the line that keeps the
    // feature honest: plenty of mail LOOKS like a bounce.
    if (!parsed.hasReport || parsed.reports.length === 0) continue
    result.parsed++

    const reportedAt = new Date(message.internalDate)
    const messageIds = [
      ...(parsed.originalMessageId ? [parsed.originalMessageId] : []),
      ...parsed.referencedMessageIds,
    ]

    for (const report of parsed.reports) {
      // Only permanent failures count. 'delayed' reports and 4.x.x statuses
      // describe a retry in progress, not a refusal.
      if (report.action !== 'failed') continue
      if (!classify(report.status)) continue

      const match = await matchSend(
        userId,
        report.recipient,
        messageIds,
        message.threadId,
        reportedAt
      )
      if (!match) {
        // We never sent to this address from this account — not ours to judge.
        result.unmatched++
        continue
      }

      const { data: outcome, error } = await supabase.rpc('record_delivery_failure', {
        p_user_id: userId,
        p_source_message_id: message.id,
        p_recipient_email: report.recipient,
        p_status_code: report.status,
        p_diagnostic: report.diagnostic,
        p_action: report.action,
        p_send_id: match.id,
        p_campaign_id: match.campaign_id,
        p_match_method: match.method,
        p_reported_at: reportedAt.toISOString(),
      })

      if (error) {
        console.error('[bounce-scan] record_delivery_failure failed:', error)
        continue
      }

      if (outcome?.duplicate) {
        result.duplicates++
      } else if (outcome?.recorded) {
        result.recorded++
        if (outcome.suppressed) {
          result.suppressed++
          console.log('[bounce-scan] suppressed', {
            userId,
            address: report.recipient,
            reason: outcome.reason,
            bounces: outcome.bounce_count,
            consecutiveBlocks: outcome.consecutive_block_count,
          })
        }
      }

      if (match.campaign_id) touchedCampaigns.add(match.campaign_id)
    }
  }

  // Sent/failed counts don't move here, but suppression can flip queued rows to
  // 'skipped', which changes whether a campaign is finished.
  await Promise.all(
    [...touchedCampaigns].map((id) =>
      supabase.rpc('refresh_campaign_progress', { p_campaign_id: id })
    )
  )

  await writeState(userId, passStartedAt, result)

  // Bounce work is committed above; replies ride along on the same token.
  if (REPLY_TRACKING_ENABLED) {
    try {
      const replies = await scanReplies(userId, accessToken)
      result.replies = replies.replies
      result.autoReplies = replies.autoReplies
    } catch (err) {
      console.error('[bounce-scan] reply scan failed:', userId, err)
      await supabase
        .from('bounce_scan_state')
        .update({ replies_last_error: String(err).slice(0, 1000) })
        .eq('user_id', userId)
    }
  }
  return result
}

// ── Replies ──────────────────────────────────────────────────
async function sendsForThreads(userId: string, threadIds: string[]): Promise<Map<string, ThreadSend[]>> {
  const byThread = new Map<string, ThreadSend[]>()
  for (let i = 0; i < threadIds.length; i += 200) {
    const { data, error } = await supabase
      .from('campaign_sends')
      .select('id, campaign_id, sent_at, gmail_thread_id')
      .eq('user_id', userId)
      .eq('status', 'sent')
      .in('gmail_thread_id', threadIds.slice(i, i + 200))
    if (error) throw error
    for (const row of data || []) {
      const list = byThread.get(row.gmail_thread_id) || []
      list.push({ id: row.id, campaign_id: row.campaign_id, sent_at: row.sent_at })
      byThread.set(row.gmail_thread_id, list)
    }
  }
  return byThread
}

async function scanReplies(userId: string, accessToken: string): Promise<{ replies: number; autoReplies: number }> {
  const out = { replies: 0, autoReplies: 0 }

  const { data: state } = await supabase
    .from('bounce_scan_state')
    .select('replies_last_scanned_at')
    .eq('user_id', userId)
    .maybeSingle()

  const cursor = state?.replies_last_scanned_at
    ? new Date(state.replies_last_scanned_at).getTime() - SCAN_OVERLAP_MINUTES * 60_000
    : Date.now() - REPLY_INITIAL_LOOKBACK_DAYS * 86400_000
  const passStartedAt = new Date()

  const refs = await listMessages(accessToken, buildReplyQuery(cursor / 1000), REPLY_MAX_LISTED_PER_USER)
  if (refs.length >= REPLY_MAX_LISTED_PER_USER) {
    console.warn('[bounce-scan] reply listing hit its cap; older messages in this window were not checked', {
      userId,
      cap: REPLY_MAX_LISTED_PER_USER,
    })
  }

  const threads = await sendsForThreads(userId, [...new Set(refs.map((r) => r.threadId))])
  const candidates = refs.filter((r) => threads.has(r.threadId)).slice(0, REPLY_MAX_FETCHED_PER_USER)

  for (const ref of candidates) {
    let meta
    try {
      meta = await getMessageMetadata(accessToken, ref.id, REPLY_METADATA_HEADERS)
    } catch (err) {
      console.warn('[bounce-scan] could not fetch reply metadata', ref.id, String(err))
      continue
    }
    // Belt and braces for `-from:me`, and bounces live in the same thread.
    if (meta.labelIds.includes('SENT') || meta.labelIds.includes('DRAFT')) continue
    if (isDeliveryNotice(meta.headers)) continue

    const send = pickSendForReply(threads.get(ref.threadId) || [], meta.internalDate)
    if (!send) continue

    const auto = isAutoReply(meta.headers)
    const { data: outcome, error } = await supabase.rpc('record_engagement_event', {
      p_send_id: send.id,
      p_kind: 'reply',
      p_filter_reason: auto ? 'auto_reply' : null,
      p_occurred_at: new Date(meta.internalDate).toISOString(),
      p_source_message_id: meta.id,
      p_from_email: parseAddress(meta.headers['from']),
      p_snippet: meta.snippet,
    })
    if (error) {
      console.error('[bounce-scan] record_engagement_event (reply) failed:', error)
      continue
    }
    if (outcome?.recorded) auto ? out.autoReplies++ : out.replies++
  }

  await supabase
    .from('bounce_scan_state')
    .update({
      replies_last_scanned_at: passStartedAt.toISOString(),
      replies_last_error: null,
      replies_recorded: out.replies,
    })
    .eq('user_id', userId)

  return out
}

async function writeState(userId: string, scannedThrough: Date | null, result: UserScanResult) {
  const row: Record<string, unknown> = {
    user_id: userId,
    last_run_at: new Date().toISOString(),
    last_status: result.status === 'ok' ? 'ok' : result.status,
    last_error: result.error ?? null,
    messages_scanned: result.scanned,
    failures_recorded: result.recorded,
    updated_at: new Date().toISOString(),
  }
  // The cursor only advances on a pass that actually completed. A failed pass
  // leaves it where it was so nothing is skipped once the problem clears.
  if (scannedThrough) row.last_scanned_at = scannedThrough.toISOString()

  const { error } = await supabase.from('bounce_scan_state').upsert(row, { onConflict: 'user_id' })
  if (error) console.error('[bounce-scan] could not write scan state:', error)
}

/* Accounts worth scanning: those that sent anything inside the match window.
   Everyone else has no mail in flight, so their mailbox holds nothing this
   function cares about.

   The order matters more than it looks. A pass is capped at
   MAX_USERS_PER_PASS, so with more active accounts than that cap the choice of
   WHICH ones to scan decides whose bounces get noticed. Taking them in
   send-recency order would mean the busiest accounts are scanned every pass and
   a quieter one below the cut is never scanned at all — its addresses would
   bounce forever without being suppressed. So candidates are ordered by how
   long it has been since they were last scanned, oldest first, which makes the
   cap a rotation instead of a cliff. */
async function usersToScan(): Promise<string[]> {
  const since = new Date(Date.now() - MATCH_LOOKBACK_DAYS * 86400_000).toISOString()
  const { data, error } = await supabase
    .from('campaign_sends')
    .select('user_id')
    .eq('status', 'sent')
    .gte('sent_at', since)
    .limit(20000)
  if (error) throw error

  const candidates = [...new Set((data || []).map((r) => r.user_id as string))]
  if (candidates.length <= MAX_USERS_PER_PASS) return candidates

  // Least recently scanned first; never-scanned accounts sort ahead of all.
  const { data: states } = await supabase
    .from('bounce_scan_state')
    .select('user_id, last_run_at')
    .in('user_id', candidates)

  const lastRun = new Map<string, number>()
  for (const s of states || []) {
    lastRun.set(s.user_id, s.last_run_at ? new Date(s.last_run_at).getTime() : 0)
  }

  return candidates
    .sort((a, b) => (lastRun.get(a) ?? 0) - (lastRun.get(b) ?? 0))
    .slice(0, MAX_USERS_PER_PASS)
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

// ── Entry point ──────────────────────────────────────────────
Deno.serve(async (req) => {
  console.log('[bounce-scan] request received:', req.method, new Date().toISOString())

  const secret = req.headers.get('x-tick-secret')
  if (!TICK_SECRET || secret !== TICK_SECRET) {
    console.warn('[bounce-scan] 401 unauthorized:', {
      secret_configured: !!TICK_SECRET,
      header_present: secret !== null,
    })
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Step 1: silence past the grace window means delivered, which is what
    // clears a block streak. Runs first so a reset is in place before this
    // pass's new blocks are counted against it.
    const { data: confirmed, error: confirmErr } = await supabase.rpc('confirm_clean_deliveries', {
      p_grace: `${DELIVERY_GRACE_HOURS} hours`,
    })
    if (confirmErr) console.error('[bounce-scan] confirm_clean_deliveries failed:', confirmErr)

    // Step 2: read each active account's failure notices.
    const userIds = await usersToScan()
    const results = await runWithConcurrency(userIds, USER_CONCURRENCY, async (userId) => {
      try {
        return await scanUser(userId)
      } catch (err) {
        console.error('[bounce-scan] user scan threw:', userId, err)
        return {
          userId,
          status: 'error' as const,
          scanned: 0,
          parsed: 0,
          recorded: 0,
          duplicates: 0,
          suppressed: 0,
          unmatched: 0,
          replies: 0,
          autoReplies: 0,
          error: String(err),
        }
      }
    })

    const totals = results.reduce(
      (acc, r) => ({
        scanned: acc.scanned + r.scanned,
        parsed: acc.parsed + r.parsed,
        recorded: acc.recorded + r.recorded,
        duplicates: acc.duplicates + r.duplicates,
        suppressed: acc.suppressed + r.suppressed,
        unmatched: acc.unmatched + r.unmatched,
        replies: acc.replies + r.replies,
        autoReplies: acc.autoReplies + r.autoReplies,
        missingScope: acc.missingScope + (r.status === 'missing_scope' ? 1 : 0),
        errored: acc.errored + (r.status === 'error' ? 1 : 0),
      }),
      { scanned: 0, parsed: 0, recorded: 0, duplicates: 0, suppressed: 0, unmatched: 0, replies: 0, autoReplies: 0, missingScope: 0, errored: 0 }
    )

    console.log('[bounce-scan] pass complete:', { users: userIds.length, ...totals, confirmed })
    return Response.json({ ok: true, users: userIds.length, confirmed, ...totals })
  } catch (err) {
    console.error('[bounce-scan] pass failed:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
