// ─────────────────────────────────────────────────────────────
// FlowState — Module 5: Subscription reminder tick (Supabase Edge Function)
//
// Invoked once a day by pg_cron (see backend/supabase/migrations/
// 20240111000000_subscription_reminder_cron.sql). Each run:
//   1. Reads every CURRENTLY ACTIVE subscription (period_end > now, straight
//      from user_subscription_status — the same "latest payment row" view
//      the rest of the app treats as the source of truth) that hasn't had
//      both its reminders sent yet.
//   2. For each, computes days-remaining the same way the status API does
//      (ceil of time left) and decides which single reminder is due: the
//      3-day warning first, then the 1-day warning — never both in one run,
//      and never the same one twice (reminder_Nd_sent_at gates it).
//   3. Sends via WhatsApp (Meta Cloud API — see ./whatsapp.ts) and stamps
//      the corresponding reminder_*_sent_at column so it's never resent for
//      this subscription period. A renewal creates a NEW payment row with
//      both columns null, so the next period gets its own fresh reminders.
//
// A user with no WhatsApp number on file, or one that fails to send, is
// logged and skipped — never marked as reminded, so it's retried on the
// next run rather than silently dropped for the rest of the period.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendSubscriptionReminder } from './whatsapp.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TICK_SECRET = Deno.env.get('SUBSCRIPTION_REMINDER_SECRET')!

console.log('[subscription-reminders] module init; env present:', {
  SUPABASE_URL: !!SUPABASE_URL,
  SERVICE_ROLE: !!SERVICE_ROLE,
  SUBSCRIPTION_REMINDER_SECRET: !!TICK_SECRET,
  WHATSAPP_PHONE_NUMBER_ID: !!Deno.env.get('WHATSAPP_PHONE_NUMBER_ID'),
  WHATSAPP_ACCESS_TOKEN: !!Deno.env.get('WHATSAPP_ACCESS_TOKEN'),
})

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const DAY_MS = 24 * 60 * 60 * 1000

interface StatusRow {
  user_id: string
  payment_id: string
  period_end: string
  reminder_3d_sent_at: string | null
  reminder_1d_sent_at: string | null
}

function daysRemaining(periodEnd: string): number {
  return Math.ceil((new Date(periodEnd).getTime() - Date.now()) / DAY_MS)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

Deno.serve(async (req) => {
  console.log('[subscription-reminders] request received:', req.method, new Date().toISOString())

  const secret = req.headers.get('x-tick-secret')
  if (!TICK_SECRET || secret !== TICK_SECRET) {
    console.warn('[subscription-reminders] 401 unauthorized:', {
      secret_configured: !!TICK_SECRET,
      header_present: secret !== null,
    })
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { data: candidates, error: statusErr } = await supabase
      .from('user_subscription_status')
      .select('user_id, payment_id, period_end, reminder_3d_sent_at, reminder_1d_sent_at')
      .eq('is_active', true)
      .or('reminder_3d_sent_at.is.null,reminder_1d_sent_at.is.null')

    if (statusErr) throw statusErr

    const rows: StatusRow[] = candidates || []
    console.log('[subscription-reminders] candidates:', rows.length)
    if (rows.length === 0) {
      return Response.json({ ok: true, candidates: 0, sent: 0, skipped: 0 })
    }

    const userIds = [...new Set(rows.map((r) => r.user_id))]
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, name, whatsapp_number')
      .in('id', userIds)

    const profileMap = new Map<string, { name: string | null; whatsapp_number: string | null }>(
      (profiles || []).map((p: { id: string; name: string | null; whatsapp_number: string | null }) => [
        p.id,
        { name: p.name, whatsapp_number: p.whatsapp_number },
      ])
    )

    let sent = 0
    let skipped = 0

    for (const row of rows) {
      const remaining = daysRemaining(row.period_end)

      // 1-day warning takes priority once we're in both windows at once
      // (e.g. the tick was skipped for a day or two) — it's the more urgent
      // of the two and the one the user explicitly required at minimum.
      let due: '1d' | '3d' | null = null
      if (remaining <= 1 && !row.reminder_1d_sent_at) due = '1d'
      else if (remaining <= 3 && !row.reminder_3d_sent_at) due = '3d'

      if (!due) continue

      const profile = profileMap.get(row.user_id)
      const phone = profile?.whatsapp_number

      if (!phone) {
        console.warn(`[subscription-reminders] user ${row.user_id} has no whatsapp_number on file — skipping ${due} reminder.`)
        skipped++
        continue
      }

      const result = await sendSubscriptionReminder(phone, {
        daysRemaining: Math.max(remaining, 0),
        expiresOn: formatDate(row.period_end),
      })

      await supabase.from('system_logs').insert({
        level: result.ok ? 'info' : 'warn',
        message: `subscription reminder (${due}) ${result.ok ? 'sent' : 'failed'} for user ${row.user_id}`,
        metadata: { user_id: row.user_id, payment_id: row.payment_id, due, ...result },
      })

      if (!result.ok) {
        // Not sent (unconfigured, bad number, or a Graph API error) — leave
        // the flag null so this is retried on tomorrow's run instead of
        // being silently skipped for the rest of the period.
        skipped++
        continue
      }

      const column = due === '1d' ? 'reminder_1d_sent_at' : 'reminder_3d_sent_at'
      await supabase
        .from('subscription_payments')
        .update({ [column]: new Date().toISOString() })
        .eq('id', row.payment_id)

      sent++
    }

    return Response.json({ ok: true, candidates: rows.length, sent, skipped })
  } catch (err) {
    console.error('[subscription-reminders] pass failed:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
