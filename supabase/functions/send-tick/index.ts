// ─────────────────────────────────────────────────────────────
// FlowState — Module 4: Sending Engine tick (Supabase Edge Function)
//
// Invoked ~every minute by pg_cron (see backend/db/05_cron_setup.sql). Each run:
//   1. Atomically CLAIMS due sends across ALL users (claim_due_sends), capping
//      per user so no single account bursts — this also flips them to 'sending'
//      so an overlapping tick can't grab them again (no double-sends).
//   2. Groups the claim by user and processes users CONCURRENTLY, but each
//      user's own emails go out one-by-one with a small gap (anti-spam spacing).
//   3. Sends via Gmail using the user's stored OAuth token. A single failure is
//      recorded and the rest continue.
//   4. Rolls up per-campaign progress.
//
// No persistent server, no worker — this whole file only runs when ticked.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptToken } from './crypto.ts'
import { renderForRecipient } from './render.ts'
import { refreshAccessToken, sendEmail, SendError, ConnectionError } from './gmail.ts'

// ── Config (Edge Function secrets) ───────────────────────────
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const TOKEN_ENCRYPTION_KEY = Deno.env.get('TOKEN_ENCRYPTION_KEY')!
const TICK_SECRET = Deno.env.get('SEND_TICK_SECRET')!

const MAX_PER_PASS = Number(Deno.env.get('SEND_MAX_PER_PASS') ?? '200')
const MAX_PER_USER = Number(Deno.env.get('SEND_MAX_PER_USER_PER_PASS') ?? '5')
const INTRA_DELAY_MS = Number(Deno.env.get('SEND_INTRA_PASS_DELAY_MS') ?? '8000')
const DEFAULT_DAILY_LIMIT = Number(Deno.env.get('SEND_DEFAULT_DAILY_LIMIT') ?? '400')
const MAX_ATTEMPTS = Number(Deno.env.get('SEND_MAX_ATTEMPTS') ?? '5')

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Send {
  id: string
  campaign_id: string
  user_id: string
  email: string
  name: string | null
  company: string | null
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

// ── Process one user's claimed batch (sequential, with spacing) ──
async function processUser(
  userId: string,
  sends: Send[],
  campaigns: Map<string, { subject: string; body: string }>,
  user: { email: string; name: string | null; daily_send_limit: number | null }
) {
  const summary = { sent: 0, failed: 0, rescheduled: 0, deferred: 0 }

  // 1) Get a valid access token for this account (one refresh per pass).
  let accessToken: string
  try {
    const { data: conn } = await supabase
      .from('google_connections')
      .select('refresh_token, status')
      .eq('user_id', userId)
      .single()

    const refreshToken = await decryptToken(conn?.refresh_token ?? null, TOKEN_ENCRYPTION_KEY)
    if (!refreshToken) throw new ConnectionError('No Gmail connection on file.', 'no_refresh_token')

    accessToken = await refreshAccessToken(refreshToken, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  } catch (err) {
    // Whole account can't send. Flag the connection so the app prompts a
    // reconnect (ties into Module 1), and retry these sends later rather than
    // burning them — unless they've been retried too many times.
    const code = err instanceof ConnectionError ? err.code : 'connection_error'
    const status = code === 'revoked' ? 'revoked' : 'expired'
    await supabase
      .from('google_connections')
      .update({ status, last_error: String(err), updated_at: new Date().toISOString() })
      .eq('user_id', userId)

    for (const s of sends) {
      const outcome = await handleRetryable(s, 30 * 60 * 1000, `connection_${code}`)
      outcome === 'failed' ? summary.failed++ : summary.rescheduled++
    }
    return summary
  }

  // 2) Runtime daily-cap safety net (across all this user's campaigns today).
  const dailyLimit = user.daily_send_limit && user.daily_send_limit > 0 ? user.daily_send_limit : DEFAULT_DAILY_LIMIT
  const { count: sentToday } = await supabase
    .from('campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'sent')
    .gte('sent_at', startOfUtcDayISO())
  let budget = dailyLimit - (sentToday || 0)

  const fromAddress = user.name ? `${user.name} <${user.email}>` : user.email

  // 3) Send this user's emails one at a time, with a gap between each.
  for (let i = 0; i < sends.length; i++) {
    const send = sends[i]

    if (budget <= 0) {
      // Over the daily cap — roll this one to tomorrow.
      await reschedule(send.id, 24 * 60 * 60 * 1000, 'daily_limit_reached')
      summary.deferred++
      continue
    }

    const campaign = campaigns.get(send.campaign_id)
    if (!campaign) {
      await markFailed(send.id, 'campaign_missing')
      summary.failed++
      continue
    }

    try {
      const { subject, body } = renderForRecipient(campaign, send)
      const messageId = await sendEmail(accessToken, {
        from: fromAddress,
        to: send.email,
        subject,
        html: body,
      })
      await markSent(send.id, messageId)
      summary.sent++
      budget--
    } catch (err) {
      if (err instanceof SendError && err.retryable) {
        const outcome = await handleRetryable(send, 5 * 60 * 1000, err.code)
        outcome === 'failed' ? summary.failed++ : summary.rescheduled++
      } else {
        // Terminal (bad address, permanent 4xx): fail this one, keep going.
        await markFailed(send.id, err instanceof Error ? err.message : String(err))
        summary.failed++
      }
    }

    // Space out sends from the SAME account (skip the wait after the last one).
    if (i < sends.length - 1) await sleep(INTRA_DELAY_MS)
  }

  return summary
}

// ── Entry point ──────────────────────────────────────────────
Deno.serve(async (req) => {
  // Shared-secret auth (the function is deployed with --no-verify-jwt; only
  // pg_cron, which knows this secret, may trigger it).
  const secret = req.headers.get('x-tick-secret')
  if (!TICK_SECRET || secret !== TICK_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // 1) Claim what's due, across every user, atomically.
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_due_sends', {
      p_max_total: MAX_PER_PASS,
      p_max_per_user: MAX_PER_USER,
      p_lock_ttl: '5 minutes',
    })
    if (claimErr) throw claimErr

    const sends: Send[] = claimed || []
    if (sends.length === 0) {
      return Response.json({ ok: true, claimed: 0 })
    }

    // 2) Batch-fetch the bits we need (campaign content, user + limits).
    const campaignIds = [...new Set(sends.map((s) => s.campaign_id))]
    const userIds = [...new Set(sends.map((s) => s.user_id))]

    const [{ data: campaignRows }, { data: userRows }] = await Promise.all([
      supabase.from('campaigns').select('id, subject, body').in('id', campaignIds),
      supabase.from('users').select('id, email, name, daily_send_limit').in('id', userIds),
    ])

    const campaigns = new Map((campaignRows || []).map((c) => [c.id, { subject: c.subject, body: c.body }]))
    const users = new Map((userRows || []).map((u) => [u.id, u]))

    // 3) Group by user; run users concurrently, each user's sends spaced.
    const byUser = new Map<string, Send[]>()
    for (const s of sends) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, [])
      byUser.get(s.user_id)!.push(s)
    }

    const perUser = await Promise.all(
      [...byUser.entries()].map(([userId, userSends]) => {
        const user = users.get(userId) || { email: '', name: null, daily_send_limit: DEFAULT_DAILY_LIMIT }
        if (!user.email) {
          // No account email — can't set a From; fail these clearly.
          return Promise.all(userSends.map((s) => markFailed(s.id, 'user_missing'))).then(() => ({
            sent: 0,
            failed: userSends.length,
            rescheduled: 0,
            deferred: 0,
          }))
        }
        return processUser(userId, userSends, campaigns, user)
      })
    )

    // 4) Roll up progress for each campaign touched this pass.
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
