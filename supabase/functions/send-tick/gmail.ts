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

/* Exchange a refresh token for a short-lived access token. Throws
   ConnectionError('revoked') when Google returns invalid_grant. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
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
  return data.access_token as string
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
  subject: string
  html: string
}): string {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n')
  return base64UrlEncode(`${headers}\r\n\r\n${opts.html}`)
}

/* Send one email. Returns the Gmail message id. Classifies failures:
   - 401/403         → retryable (token race); caller can reclaim next pass
   - 429 / 5xx       → retryable (rate limit / transient Google error)
   - 400 and other 4xx → terminal (bad address, etc.) → mark failed */
export async function sendEmail(
  accessToken: string,
  opts: { from: string; to: string; subject: string; html: string }
): Promise<string> {
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
    return (data.id as string) || ''
  }

  const errBody = await res.text().catch(() => '')
  const retryable = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403
  throw new SendError(`Gmail send failed (${res.status}): ${errBody.slice(0, 300)}`, {
    retryable,
    code: `http_${res.status}`,
  })
}
