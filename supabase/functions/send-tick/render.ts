// Personalization — a compact port of backend/src/lib/personalize.js so that
// what the sender fills in matches the app's live preview. Replaces {{token}}
// placeholders using a recipient's snapshotted fields.

const TOKEN_RE = /\{\{\s*([\w\s-]+?)\s*\}\}/g

function normalizeToken(token: string): string {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export interface RecipientLike {
  email?: string | null
  name?: string | null
  company?: string | null
  extra?: Record<string, unknown> | null
}

function buildContext(recipient: RecipientLike): Record<string, string> {
  const ctx: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    if (value == null || value === '') return
    ctx[normalizeToken(key)] = String(value)
  }

  put('email', recipient.email)
  put('name', recipient.name)
  put('full_name', recipient.name)
  put('company', recipient.company)

  if (recipient.name) {
    const parts = String(recipient.name).trim().split(/\s+/)
    put('first_name', parts[0])
    if (parts.length > 1) put('last_name', parts[parts.length - 1])
  }

  if (recipient.extra && typeof recipient.extra === 'object') {
    for (const [k, v] of Object.entries(recipient.extra)) put(k, v)
  }
  return ctx
}

// Unresolved tokens are dropped (this is a real send, not a preview).
function renderText(text: string, ctx: Record<string, string>): string {
  if (!text) return ''
  return String(text).replace(TOKEN_RE, (_whole, raw) => {
    const key = normalizeToken(raw)
    return key in ctx ? ctx[key] : ''
  })
}

export function renderForRecipient(
  campaign: { subject: string; body: string },
  recipient: RecipientLike
): { subject: string; body: string } {
  const ctx = buildContext(recipient)
  return {
    subject: renderText(campaign.subject, ctx),
    body: renderText(campaign.body, ctx),
  }
}
