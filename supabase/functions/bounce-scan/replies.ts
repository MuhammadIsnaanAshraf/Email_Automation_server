// Reply detection — the pure half. The scanner in index.ts lists recent inbound
// mail, keeps only messages whose Gmail thread belongs to one of our sends, and
// asks these helpers what each one is.
//
// A message in a send's thread is one of three things:
//   - a delivery notice (bounce) → not a reply; bounce-scan's DSN path owns it
//   - an autoresponder           → recorded, flagged 'auto_reply', not counted
//   - a reply                    → counted
// Autoresponders are judged by the headers RFC 3834 defines for exactly this
// purpose, with the subject line only as a fallback for systems that ignore it.

export const REPLY_METADATA_HEADERS = [
  'From',
  'Subject',
  'Content-Type',
  'Auto-Submitted',
  'X-Autoreply',
  'X-Autorespond',
  'X-Auto-Response-Suppress',
  'Precedence',
  'X-Failed-Recipients',
]

/* Inbound mail since the cursor. `-from:me` drops the account's own messages
   (including its follow-ups in the same thread); `in:anywhere` keeps replies a
   filter archived or Gmail misfiled as spam. */
export function buildReplyQuery(afterEpochSeconds: number): string {
  return `in:anywhere -in:chats -in:drafts -from:me after:${Math.floor(afterEpochSeconds)}`
}

/* "Jane Doe <Jane@Example.com>" → "jane@example.com". */
export function parseAddress(from: string | undefined | null): string | null {
  if (!from) return null
  const angle = from.match(/<([^>]+)>/)
  const candidate = (angle ? angle[1] : from).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : null
}

type Headers = Record<string, string | undefined>

export function isDeliveryNotice(headers: Headers): boolean {
  const from = (headers['from'] || '').toLowerCase()
  if (/mailer-daemon|postmaster|mail delivery (subsystem|system)/.test(from)) return true
  if (/multipart\/report/i.test(headers['content-type'] || '')) return true
  return !!headers['x-failed-recipients']
}

const AUTO_SUBJECT = new RegExp(
  '^\\s*(' +
    [
      'auto(matic)?[ -]?reply',
      'autoreply',
      'auto[ -]?response',
      'out of (the )?office',
      'ooo\\b',
      'away from (the )?office',
      'on vacation',
      'abwesenheitsnotiz',
      'automatische antwort',
      'réponse automatique',
      'respuesta automática',
      'risposta automatica',
      'resposta automática',
    ].join('|') +
    ')',
  'i'
)

export function isAutoReply(headers: Headers): boolean {
  // RFC 3834: anything other than "no" means a machine sent it.
  const autoSubmitted = (headers['auto-submitted'] || '').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return true
  if (headers['x-autoreply'] !== undefined || headers['x-autorespond'] !== undefined) return true
  // Exchange stamps this on its out-of-office replies.
  if (/\b(oof|autoreply)\b/i.test(headers['x-auto-response-suppress'] || '')) return true
  if (/^(auto_reply|bulk|junk)$/i.test((headers['precedence'] || '').trim())) return true
  return AUTO_SUBJECT.test(headers['subject'] || '')
}

export interface ThreadSend {
  id: string
  campaign_id: string
  sent_at: string
}

/* Gmail can file two of our sends in one thread (same subject, same recipient).
   The reply belongs to the latest one that went out before it arrived. */
export function pickSendForReply(sends: ThreadSend[], receivedAt: number): ThreadSend | null {
  let best: ThreadSend | null = null
  for (const s of sends) {
    const t = new Date(s.sent_at).getTime()
    if (!Number.isFinite(t) || t > receivedAt) continue
    if (!best || t > new Date(best.sent_at).getTime()) best = s
  }
  return best
}
