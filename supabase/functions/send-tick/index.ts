// ─────────────────────────────────────────────────────────────
// FlowState — Module 4: Sending Engine tick (Supabase Edge Function)
//
// Invoked ~every minute by pg_cron (see backend/db/05_cron_setup.sql). Each run:
//   1. Atomically CLAIMS due sends across ALL users (claim_due_sends), capping
//      to ONE send per user per tick — so a single account never bursts, even
//      if several of its campaigns happen to collide on the same due slot.
//      There's no cap on the total claimed in one pass; the natural ceiling is
//      "one per account with something due". Rows a user couldn't get to this
//      tick are pushed to the next minute by claim_due_sends itself (tracked
//      via reschedule_count), never left behind with a stale scheduled_at.
//   2. Processes users CONCURRENTLY — each user contributes at most one send,
//      so there's no per-user pacing loop needed within a single tick.
//   3. Sends via Gmail using a CACHED access token (google_connections.access_token),
//      refreshed only when it's actually expired — not on every tick. Campaign
//      scheduling (backend/src/services/campaigns.js) mints one eagerly up
//      front, so a healthy account's tick almost never pays for the refresh
//      round-trip. A single send failure is recorded and the rest continue.
//   4. Rolls up per-campaign progress.
//
// No persistent server, no worker — this whole file only runs when ticked.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2'
import { decryptToken, encryptToken } from './crypto.ts'
import { renderForRecipient } from './render.ts'
import { refreshAccessToken, sendEmail, SendError, ConnectionError } from './gmail.ts'

// How much longer a cached access token must still have left before we'll
// reuse it without hitting Google. Access tokens mint ~1hr; campaigns are
// scheduled (and a token is minted eagerly) at that time by the Express
// backend, so most ticks hit this cache and skip the refresh round-trip
// entirely instead of paying for it on every user, every minute.
const TOKEN_EXPIRY_BUFFER_MS = 60_000

// ── Config (Edge Function secrets) ───────────────────────────
// SUPABASE_URL / SERVICE_ROLE are auto-injected by the Edge runtime; the rest
// are secrets you set with `supabase secrets set`. We read them all up front and
// log *presence only* (never values) at cold boot, so a missing secret shows up
// as a clear boot log instead of a silent 401 or a per-user decrypt failure.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const TOKEN_ENCRYPTION_KEY = Deno.env.get('TOKEN_ENCRYPTION_KEY')!
const TICK_SECRET = Deno.env.get('SEND_TICK_SECRET')!

// One send per account per tick (the tick itself runs once a minute).
const MAX_PER_USER = Number(Deno.env.get('SEND_MAX_PER_USER_PER_PASS') ?? '1')
const DEFAULT_DAILY_LIMIT = Number(Deno.env.get('SEND_DEFAULT_DAILY_LIMIT') ?? '400')
const MAX_ATTEMPTS = Number(Deno.env.get('SEND_MAX_ATTEMPTS') ?? '5')

// This runs once per cold boot, at module load. If you DON'T see this line in
// the logs, the module is crashing before it (bad import / bad env) — that is
// the "booted then shutdown with no logs" case.
console.log('[send-tick] module init; env present:', {
  SUPABASE_URL: !!SUPABASE_URL,
  SERVICE_ROLE: !!SERVICE_ROLE,
  GOOGLE_CLIENT_ID: !!GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: !!GOOGLE_CLIENT_SECRET,
  TOKEN_ENCRYPTION_KEY: !!TOKEN_ENCRYPTION_KEY,
  SEND_TICK_SECRET: !!TICK_SECRET,
})

// createClient throws at module load if the URL is empty. Do it defensively so
// the reason lands in the logs rather than a bare "shutdown".
function initClient() {
  try {
    return createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  } catch (err) {
    console.error('[send-tick] FATAL: createClient failed at module init:', err)
    throw err
  }
}
const supabase = initClient()

interface Send {
  id: string
  campaign_id: string
  user_id: string
  email: string
  name: string | null
  company: string | null
  cc: string | null
  bcc: string | null
  extra: Record<string, unknown> | null
  attempts: number
}

// ── Per-send outcome writers ─────────────────────────────────
async function markSent(id: string, messageId: string) {
  await supabase
    .from('campaign_sends')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      gmail_message_id: messageId,
      error: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
}

async function markFailed(id: string, error: string) {
  await supabase
    .from('campaign_sends')
    .update({ status: 'failed', error, locked_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
}

// Put a send back in the queue for a later pass (transient error / over budget).
async function reschedule(id: string, delayMs: number, error: string | null = null) {
  await supabase
    .from('campaign_sends')
    .update({
      status: 'scheduled',
      scheduled_at: new Date(Date.now() + delayMs).toISOString(),
      locked_at: null,
      error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
}

// Retryable failures reschedule with backoff until attempts run out, then fail.
async function handleRetryable(send: Send, delayMs: number, error: string) {
  if (send.attempts >= MAX_ATTEMPTS) {
    await markFailed(send.id, `${error} (gave up after ${send.attempts} attempts)`)
    return 'failed'
  }
  await reschedule(send.id, delayMs, error)
  return 'rescheduled'
}

function startOfUtcDayISO(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

// ── Process one user's single claimed send for this tick ─────
async function processUserSend(
  userId: string,
  send: Send,
  campaigns: Map<string, { subject: string; body: string }>,
  user: { email: string; name: string | null; daily_send_limit: number | null }
) {
  const summary = { sent: 0, failed: 0, rescheduled: 0, deferred: 0 }

  // 1) Get a valid access token for this account — reuse the cached one from
  // google_connections (minted at campaign-schedule time, or by an earlier
  // tick) as long as it's not near expiry. Only talk to Google when it's
  // actually stale, instead of refreshing unconditionally every tick.
  let accessToken: string
  try {
    const { data: conn } = await supabase
    .from('google_connections')
    .select('refresh_token, access_token, token_expiry, status')
    .eq('user_id', userId)
    .single()
    console.log("🚀 ~ processUserSend ~ data:", conn)

    const expiry = conn?.token_expiry ? new Date(conn.token_expiry).getTime() : 0
    const cached = conn?.access_token ? await decryptToken(conn.access_token, TOKEN_ENCRYPTION_KEY) : null

    if (cached && expiry - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
      accessToken = cached
    } else {
      const refreshToken = await decryptToken(conn?.refresh_token ?? null, TOKEN_ENCRYPTION_KEY)
      console.log("🚀 ~ processUserSend ~ refreshToken:", refreshToken)
      if (!refreshToken) throw new ConnectionError('No Gmail connection on file.', 'no_refresh_token')

      const refreshed = await refreshAccessToken(refreshToken, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
      console.log("🚀 ~ processUserSend ~ refreshed:", refreshed)
      accessToken = refreshed.accessToken
      await supabase
        .from('google_connections')
        .update({
          access_token: await encryptToken(refreshed.accessToken, TOKEN_ENCRYPTION_KEY),
          token_expiry: new Date(refreshed.expiresAt).toISOString(),
          status: 'connected',
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
    }
  } catch (err) {
    // Whole account can't send. Flag the connection so the app prompts a
    // reconnect (ties into Module 1), and retry later rather than burning
    // this send — unless it's been retried too many times.
    const code = err instanceof ConnectionError ? err.code : 'connection_error'
    const status = code === 'revoked' ? 'revoked' : 'expired'
    await supabase
      .from('google_connections')
      .update({ status, last_error: String(err), updated_at: new Date().toISOString() })
      .eq('user_id', userId)

    const outcome = await handleRetryable(send, 30 * 60 * 1000, `connection_${code}`)
    outcome === 'failed' ? summary.failed++ : summary.rescheduled++
    return summary
  }

  // 2) Runtime daily-cap safety net (across all this user's campaigns today).
  const dailyLimit = user.daily_send_limit && user.daily_send_limit > 0 ? user.daily_send_limit : DEFAULT_DAILY_LIMIT
  console.log("🚀 ~ processUserSend ~ dailyLimit:", dailyLimit)
  const { count: sentToday } = await supabase
    .from('campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'sent')
    .gte('sent_at', startOfUtcDayISO())

  if (dailyLimit - (sentToday || 0) <= 0) {
    // Over the daily cap — roll this one to tomorrow.
    await reschedule(send.id, 24 * 60 * 60 * 1000, 'daily_limit_reached')
    summary.deferred++
    return summary
  }

  const campaign = campaigns.get(send.campaign_id)
  if (!campaign) {
    await markFailed(send.id, 'campaign_missing')
    summary.failed++
    return summary
  }

  const fromAddress = user.name ? `${user.name} <${user.email}>` : user.email

  try {
    const { subject, body } = renderForRecipient(campaign, send)
    const messageId = await sendEmail(accessToken, {
      from: fromAddress,
      to: send.email,
      cc: send.cc,
      bcc: send.bcc,
      subject,
      html: body,
    })
    await markSent(send.id, messageId)
    summary.sent++
  } catch (err) {
    if (err instanceof SendError && err.retryable) {
      if (err.code === 'http_401') {
        // Gmail rejected the cached token outright even though our clock
        // thought it still had time left — clear the cache so the next
        // attempt is forced to mint a fresh one instead of reusing it for
        // up to another hour.
        await supabase
          .from('google_connections')
          .update({ access_token: null, token_expiry: null })
          .eq('user_id', userId)
      }
      const outcome = await handleRetryable(send, 5 * 60 * 1000, err.code)
      outcome === 'failed' ? summary.failed++ : summary.rescheduled++
    } else {
      // Terminal (bad address, permanent 4xx): fail this one.
      await markFailed(send.id, err instanceof Error ? err.message : String(err))
      summary.failed++
    }
  }

  return summary
}

// ── Entry point ──────────────────────────────────────────────
Deno.serve(async (req) => {
  // First line of every invocation. If this never appears but "booted" does,
  // the request is not reaching the handler at all.
  console.log('[send-tick] request received:', req.method, new Date().toISOString())

  // Shared-secret auth (the function is deployed with --no-verify-jwt; only
  // pg_cron, which knows this secret, may trigger it).
  const secret = req.headers.get('x-tick-secret')
  if (!TICK_SECRET || secret !== TICK_SECRET) {
    // Spell out *why* it's a 401 so a missing secret vs. a mismatched one is
    // obvious in the logs (values never logged — just whether they're set).
    console.warn('[send-tick] 401 unauthorized:', {
      tick_secret_configured: !!TICK_SECRET,
      header_present: secret !== null,
      header_matches: !!TICK_SECRET && secret === TICK_SECRET,
    })
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // 1) Claim what's due, across every user, atomically. Capped per user
    // (default 1); no cap on the total claimed in one pass.
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_due_sends', {
      p_max_per_user: MAX_PER_USER,
      p_lock_ttl: '5 minutes',
    })
    console.log("🚀 ~ claimed:", claimed)
    if (claimErr) throw claimErr

    const sends: Send[] = claimed || []
    console.log("🚀 ~ sends.length:", sends.length)
    if (sends.length === 0) {
      return Response.json({ ok: true, claimed: 0 })
    }

    // 2) Batch-fetch the bits we need (campaign content, user + limits).
    const campaignIds = [...new Set(sends.map((s) => s.campaign_id))]
    console.log("🚀 ~ campaignIds:", campaignIds)
    const userIds = [...new Set(sends.map((s) => s.user_id))]
    console.log("🚀 ~ userIds:", userIds)

    const [{ data: campaignRows }, { data: profileRows }, { data: settingsRows }] = await Promise.all([
      supabase.from('campaigns').select('id, subject, body').in('id', campaignIds),
      supabase.from('profiles').select('id, email, name').in('id', userIds),
      supabase.from('user_settings').select('user_id, daily_send_limit').in('user_id', userIds),
    ])
    console.log("🚀 ~ campaignRows:", campaignRows)

    const profiles = new Map<string, { email: string; name: string | null }>(
      (profileRows || []).map((p: { id: string; email: string; name: string | null }) => [p.id, p])
    )
    const settings = new Map<string, number | null>(
      (settingsRows || []).map((s: { user_id: string; daily_send_limit: number | null }) => [
        s.user_id,
        s.daily_send_limit,
      ])
    )
    const campaigns = new Map<string, { subject: string; body: string }>(
      (campaignRows || []).map((c: { id: string; subject: string; body: string }) => [
        c.id,
        { subject: c.subject, body: c.body },
      ])
    )
    const users = new Map<string, { email: string; name: string | null; daily_send_limit: number }>()
    console.log("🚀 ~ users:", users)
    for (const userId of userIds) {
      const p = profiles.get(userId)
      const limit = settings.get(userId) ?? DEFAULT_DAILY_LIMIT
      users.set(userId, { email: p?.email ?? '', name: p?.name ?? null, daily_send_limit: limit })
    }

    // 3) Claim caps to one row per user, so this is naturally 1:1 — but stay
    // defensive and only take the first if that ever isn't the case.
    const byUser = new Map<string, Send>()
    for (const s of sends) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, s)
    }

    // 4) Run every user's single send concurrently.
    const results = await Promise.allSettled(
      [...byUser.entries()].map(([userId, send]) => {
        const user = users.get(userId) || { email: '', name: null, daily_send_limit: DEFAULT_DAILY_LIMIT }
        if (!user.email) {
          // No account email — can't set a From; fail this clearly.
          return markFailed(send.id, 'user_missing').then(() => ({
            sent: 0,
            failed: 1,
            rescheduled: 0,
            deferred: 0,
          }))
        }
        return processUserSend(userId, send, campaigns, user)
      })
    )
    console.log("🚀 ~ results:", results)

    // Log any per-user failures and extract summaries.
    const perUser = results.map((r) => {
      if (r.status === 'rejected') {
        console.error('[send-tick] per-user send failed:', r.reason)
        return { sent: 0, failed: 0, rescheduled: 0, deferred: 0 }
      }
      return r.value
    })

    // 5) Roll up progress for each campaign touched this pass.
    await Promise.all(campaignIds.map((id) => supabase.rpc('refresh_campaign_progress', { p_campaign_id: id })))

    const totals = perUser.reduce(
      (acc, s) => ({
        sent: acc.sent + s.sent,
        failed: acc.failed + s.failed,
        rescheduled: acc.rescheduled + s.rescheduled,
        deferred: acc.deferred + s.deferred,
      }),
      { sent: 0, failed: 0, rescheduled: 0, deferred: 0 }
    )

    return Response.json({ ok: true, claimed: sends.length, users: byUser.size, ...totals })
  } catch (err) {
    console.error('[send-tick] pass failed:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
