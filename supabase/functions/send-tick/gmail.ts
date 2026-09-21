// Gmail sending: refresh a user's OAuth access token, then send a message via
// the Gmail REST API. Errors are classified as retryable vs terminal so the
// caller can decide whether to reschedule or mark the send failed.

export class SendError extends Error {
  retryable: boolean
  code: string
  /* Gmail's raw error body. Kept because a rejection sometimes quotes the
     receiving server's own SMTP reply, enhanced status code and all — which is
     the same evidence a bounce notice carries, just delivered synchronously. */
  body: string | null
  constructor(message: string, { retryable = false, code = 'send_failed', body = null } = {}) {
    super(message)
    this.name = 'SendError'
    this.retryable = retryable
    this.code = code
    this.body = body
  }
}

// Google revoked the grant / no valid refresh token → user must reconnect.
export class ConnectionError extends Error {
  code: string
  constructor(message: string, code = 'connection_unavailable') {
    super(message)
    this.name = 'ConnectionError'
    this.code = code
  }
}

export interface RefreshedToken {
  accessToken: string
  expiresAt: number // ms since epoch
  /* The scopes Google actually granted, as it reports them on every refresh.
     Worth capturing because google_connections.scopes is written optimistically
     at sign-in (the OAuth callback stores what we ASKED for, since Supabase
     doesn't hand us Google's grant response). A user who unticks a permission,
     or who connected before a scope was added to the request, would otherwise
     look permanently capable of something they never authorized. Refreshing is
     the first moment we hear the truth, so that is when we record it. */
  scopes: string[] | null
}

/* Exchange a refresh token for a short-lived access token. Throws
   ConnectionError('revoked') when Google returns invalid_grant. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<RefreshedToken> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      throw new ConnectionError('Google access was revoked or expired.', 'revoked')
    }
    throw new ConnectionError(`Token refresh failed: ${data.error || res.status}`)
  }
  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600
  return {
    accessToken: data.access_token as string,
    expiresAt: Date.now() + expiresInSec * 1000,
    // Space-delimited on the wire. Absent on some responses — null then means
    // "no news", and callers must leave the stored value alone rather than
    // clobber it with an empty list.
    scopes: typeof data.scope === 'string' && data.scope.trim()
      ? data.scope.trim().split(/\s+/)
      : null,
  }
}

// base64url-encode a UTF-8 string (Gmail wants the raw MIME in base64url).
function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// RFC 2047 encode a header value if it contains non-ASCII (e.g. an emoji subject).
function encodeHeader(value: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`
}

function buildRawMessage(opts: {
  from: string
  to: string
  cc?: string | null
  bcc?: string | null
  subject: string
  html: string
}): string {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  // Cc/Bcc ride on this same MIME message — Gmail delivers to them in the one
  // send call, no extra API round-trips. Bcc recipients are copied but the
  // header is stripped from the message everyone receives.
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
  lines.push(
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  )
  return base64UrlEncode(`${lines.join('\r\n')}\r\n\r\n${opts.html}`)
}

export interface SentMessage {
  /** Gmail's own id for the sent message. */
  id: string
  /** The thread Gmail filed it under. A bounce notice lands in this same
      thread, which is the cheapest way to tie the two together later. */
  threadId: string
}

/* Send one email. Returns the Gmail message + thread ids. Classifies failures:
   - 401/403         → retryable (token race); caller can reclaim next pass
   - 429 / 5xx       → retryable (rate limit / transient Google error)
   - 400 and other 4xx → terminal (bad address, etc.) → mark failed */
export async function sendEmail(
  accessToken: string,
  opts: { from: string; to: string; cc?: string | null; bcc?: string | null; subject: string; html: string }
): Promise<SentMessage> {
  const raw = buildRawMessage(opts)
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    }
  )

  if (res.ok) {
    const data = await res.json().catch(() => ({}))
    return { id: (data.id as string) || '', threadId: (data.threadId as string) || '' }
  }

  const errBody = await res.text().catch(() => '')
  // A 403 here is almost always Gmail rejecting the `From:` header as not
  // owned by the authenticated account (or the Gmail API not being enabled
  // for the project) — log the from/to alongside the body since the status
  // code alone ("http_403") isn't enough to tell which.
  console.error(`[gmail] send failed ${res.status} from=${opts.from} to=${opts.to}:`, errBody.slice(0, 1000))
  const retryable = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403
  throw new SendError(`Gmail send failed (${res.status}): ${errBody.slice(0, 300)}`, {
    retryable,
    code: `http_${res.status}`,
    body: errBody,
  })
}

/* Read back the RFC 822 Message-ID Gmail assigned to a message we just sent.
   Gmail overwrites any Message-ID we put in the raw MIME, so this round-trip
   is the only way to learn it — and knowing it is what later lets a bounce
   notice be tied to one exact send rather than "some recent mail to this
   address".

   Best-effort by design: it needs a read scope the account may not have
   granted yet, and a send that already succeeded must never be undone by a
   failure here. Returns null and the caller carries on. */
export async function fetchMessageId(accessToken: string, messageId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}` +
        '?format=metadata&metadataHeaders=Message-ID',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!res.ok) return null
    const data = await res.json().catch(() => ({}))
    const headers: Array<{ name: string; value: string }> = data?.payload?.headers || []
    const found = headers.find((h) => h.name?.toLowerCase() === 'message-id')
    return found?.value?.trim() || null
  } catch {
    return null
  }
}

/* Pull an RFC 3463 enhanced status code out of a Gmail error body, but ONLY
   when that code unambiguously describes the recipient's mailbox.

   Gmail forwards the receiving server's SMTP reply verbatim when it refuses a
   send synchronously, e.g. "550-5.1.1 The email account that you tried to
   reach does not exist". Reading the code out of that text is transcription of
   the receiving server's verdict, not a guess about it.

   The catch is that most of Gmail's synchronous errors are about US, not the
   recipient — exhausted daily quota (5.4.5), rate limits, revoked auth,
   malformed requests. Those arrive through the same channel and carry
   perfectly valid-looking 5.x.x codes, and counting one as a bounce would
   blacklist a working address for the sender's own mistake. So this path
   accepts only the two families that no mail system uses to describe the
   sender:

     5.1.x  bad destination mailbox — no such user, address rejected
     5.2.x  mailbox unavailable — full, disabled, not accepting mail

   Everything else returns null and takes the ordinary retry path. Nothing is
   lost by being strict here: a genuine policy block still produces a proper
   delivery-status notice minutes later, and bounce-scan reads that through
   record_delivery_failure, which is the authoritative path anyway. */
const RECIPIENT_SCOPED = /^5\.[12]\./

export function extractEnhancedStatus(body: string | null): string | null {
  if (!body) return null
  // Scan every code in the body rather than just the first: Gmail's replies
  // sometimes lead with a generic code and give the specific one after.
  const matches = body.match(/\b[45]\.\d{1,3}\.\d{1,3}\b/g)
  if (!matches) return null
  return matches.find((code) => RECIPIENT_SCOPED.test(code)) ?? null
}
