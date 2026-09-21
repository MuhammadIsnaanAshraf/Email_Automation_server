// Read-side Gmail helpers for the bounce scanner: find candidate failure
// notices in the sending account's own mailbox and pull their raw MIME so the
// DSN parser can read the machine-readable report.
//
// Requires the https://www.googleapis.com/auth/gmail.readonly scope. An account
// that has not re-consented since that scope was added gets a 403 here; the
// caller records 'missing_scope' against it and the UI prompts a reconnect.

export class GmailReadError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'GmailReadError'
    this.status = status
    this.code = code
  }
}

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/* Discovery query. Deliberately WIDE: it costs one cheap list call and the
   verdict is decided later by parsing the actual delivery-status report, so a
   false positive here is harmless while a miss means a real bounce goes
   uncounted. `in:anywhere` matters because bounce notices land in Spam often
   enough to skew the numbers if they're excluded.

   `after:` takes unix seconds, and Gmail's own search resolution is a day — so
   the caller also filters on internalDate, and this is just the coarse net. */
export function buildBounceQuery(afterEpochSeconds: number): string {
  const senders = [
    'from:mailer-daemon',
    'from:postmaster',
    'from:mailer-daemon@googlemail.com',
    'from:noreply@dmarcreport.com',
  ]
  const subjects = [
    'subject:"Delivery Status Notification"',
    'subject:"Undelivered Mail Returned to Sender"',
    'subject:"Delivery incomplete"',
    'subject:"Delivery Failure"',
    'subject:"failure notice"',
    'subject:"Returned mail"',
    'subject:"Undeliverable"',
  ]
  return `in:anywhere after:${Math.floor(afterEpochSeconds)} (${[...senders, ...subjects].join(' OR ')})`
}

async function gmailFetch(accessToken: string, path: string): Promise<Response> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.ok) return res

  const body = await res.text().catch(() => '')
  // 403 with an insufficient-scope / permission body is the "user hasn't
  // re-consented to gmail.readonly" case, which is a prompt-to-reconnect, not
  // an error to retry.
  if (res.status === 403 && /insufficient|scope|permission/i.test(body)) {
    throw new GmailReadError('Gmail read permission not granted.', 403, 'missing_scope')
  }
  if (res.status === 401) {
    throw new GmailReadError('Gmail rejected the access token.', 401, 'unauthorized')
  }
  throw new GmailReadError(
    `Gmail read failed (${res.status}): ${body.slice(0, 300)}`,
    res.status,
    `http_${res.status}`
  )
}

export interface MessageRef {
  id: string
  threadId: string
}

/* List candidate notices, newest first, following pagination up to `maxTotal`.
   Gmail caps a page at 500; we ask for 100 so a pathological mailbox can't
   stall one tick. */
export async function listBounceCandidates(
  accessToken: string,
  afterEpochSeconds: number,
  maxTotal = 100
): Promise<MessageRef[]> {
  const query = encodeURIComponent(buildBounceQuery(afterEpochSeconds))
  const out: MessageRef[] = []
  let pageToken: string | undefined

  while (out.length < maxTotal) {
    const pageSize = Math.min(100, maxTotal - out.length)
    const path =
      `/messages?q=${query}&maxResults=${pageSize}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    const res = await gmailFetch(accessToken, path)
    const data = await res.json().catch(() => ({}))

    for (const m of data.messages || []) {
      out.push({ id: m.id, threadId: m.threadId })
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }

  return out
}

export interface RawMessage {
  id: string
  threadId: string
  /** Milliseconds since epoch, as Gmail recorded receipt. */
  internalDate: number
  /** Decoded RFC 822 source. */
  raw: string
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // Bounce notices quote the original message, which may be any charset. Never
  // throw on a bad byte — a mangled character must not cost us the report.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export async function getRawMessage(accessToken: string, id: string): Promise<RawMessage> {
  const res = await gmailFetch(accessToken, `/messages/${id}?format=raw`)
  const data = await res.json()
  return {
    id: data.id,
    threadId: data.threadId,
    internalDate: Number(data.internalDate) || Date.now(),
    raw: data.raw ? base64UrlDecode(data.raw) : '',
  }
}

/* The RFC 822 Message-ID Gmail assigned to a message we sent. Gmail overwrites
   whatever Message-ID we put in the raw MIME, so the only way to learn it is to
   read it back — and knowing it is what lets a bounce be tied to one exact
   send instead of "some recent mail to this address".

   Uses format=metadata, which the gmail.metadata scope alone would satisfy, so
   this keeps working even on an account that has only partially re-consented. */
export async function getSentMessageId(
  accessToken: string,
  id: string
): Promise<string | null> {
  const res = await gmailFetch(
    accessToken,
    `/messages/${id}?format=metadata&metadataHeaders=Message-ID`
  )
  const data = await res.json().catch(() => ({}))
  const headers: Array<{ name: string; value: string }> = data.payload?.headers || []
  const found = headers.find((h) => h.name.toLowerCase() === 'message-id')
  return found?.value?.trim() || null
}
