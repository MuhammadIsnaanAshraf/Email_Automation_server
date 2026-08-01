// ─────────────────────────────────────────────────────────────
// WhatsApp sending via Meta's WhatsApp Cloud API (official, no third-party
// relay). Chosen over Twilio's WhatsApp API because this is a proactive,
// business-initiated message (not a reply within a 24h customer-service
// window) — Meta requires those to use a pre-approved Message Template
// regardless of which provider fronts them, so going straight to Meta avoids
// paying a middleman for the same restriction. Trade-off: you must create
// and get the template approved once in Meta Business Manager before this
// can send anything (see the setup note below) — Twilio's own template
// approval flow is no simpler, so this doesn't cost extra setup either way.
//
// ── One-time setup ────────────────────────────────────────────
// 1. Meta Business Manager → WhatsApp → API Setup: get a permanent access
//    token and the "Phone number ID" for your sending number.
// 2. Meta Business Manager → Account tools → Message Templates: create a
//    template (Category: Utility) with ONE body variable, e.g.:
//      Name: subscription_expiring
//      Body: "Hi! Your FlowState subscription expires in {{1}} day(s) on
//             {{2}}. Reply here or contact us to renew and keep sending."
//    Submit for review — approval is usually within minutes to a few hours.
// 3. Set these Edge Function secrets (`supabase secrets set NAME=value`):
//      WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
//    Optional (defaults shown):
//      WHATSAPP_TEMPLATE_NAME=subscription_expiring
//      WHATSAPP_TEMPLATE_LANG=en_US
// Until these are set, sendReminder() logs and returns { skipped: true }
// instead of throwing — a missing WhatsApp integration should never take
// down the rest of the reminder tick (or, further upstream, any other job).
// ─────────────────────────────────────────────────────────────

const GRAPH_VERSION = 'v20.0'

export interface WhatsAppResult {
  ok: boolean
  skipped?: boolean
  reason?: string
  messageId?: string
}

/* Digits-only, country code included, no leading '+' — what the Cloud API's
   `to` field expects. Rejects anything that doesn't look like a real number
   rather than silently sending to a mangled destination. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '')
  return digits.length >= 8 ? digits : null
}

export async function sendSubscriptionReminder(
  toRaw: string,
  { daysRemaining, expiresOn }: { daysRemaining: number; expiresOn: string }
): Promise<WhatsAppResult> {
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const templateName = Deno.env.get('WHATSAPP_TEMPLATE_NAME') || 'subscription_expiring'
  const templateLang = Deno.env.get('WHATSAPP_TEMPLATE_LANG') || 'en_US'

  if (!phoneNumberId || !accessToken) {
    console.warn('[whatsapp] WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN not set — skipping send, will retry next tick.')
    return { ok: false, skipped: true, reason: 'not_configured' }
  }

  const to = normalizePhone(toRaw)
  if (!to) {
    return { ok: false, skipped: true, reason: 'invalid_phone' }
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLang },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: String(daysRemaining) },
              { type: 'text', text: expiresOn },
            ],
          },
        ],
      },
    }),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error(`[whatsapp] send failed ${res.status} to=${to}:`, errBody.slice(0, 500))
    return { ok: false, reason: `http_${res.status}` }
  }

  const data = await res.json().catch(() => ({}))
  const messageId = data?.messages?.[0]?.id
  return { ok: true, messageId }
}
