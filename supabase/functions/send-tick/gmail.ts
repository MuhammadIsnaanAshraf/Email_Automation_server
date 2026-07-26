// Gmail sending: refresh a user's OAuth access token, then send a message via
// the Gmail REST API. Errors are classified as retryable vs terminal so the
// caller can decide whether to reschedule or mark the send failed.

export class SendError extends Error {
  retryable: boolean
  code: string
  constructor(message: string, { retryable = false, code = 'send_failed' } = {}) {
    super(message)
    this.name = 'SendError'
    this.retryable = retryable
    this.code = code
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

/* Send one email. Returns the Gmail message id. Classifies failures:
   - 401/403         → retryable (token race); caller can reclaim next pass
   - 429 / 5xx       → retryable (rate limit / transient Google error)
   - 400 and other 4xx → terminal (bad address, etc.) → mark failed */
export async function sendEmail(
  accessToken: string,
  opts: { from: string; to: string; cc?: string | null; bcc?: string | null; subject: string; html: string }
): Promise<string> {
  const raw = buildRawMessage(opts)
  console.log("🚀 ~ sendEmail ~ raw:", raw)
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
  console.log("🚀 ~ sendEmail ~ res:", res)

  if (res.ok) {
    const data = await res.json().catch(() => ({}))
    console.log("🚀 ~ sendEmail ~ data:", data)
    return (data.id as string) || ''
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
  })
}
