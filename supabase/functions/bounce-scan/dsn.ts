// ─────────────────────────────────────────────────────────────
// Delivery Status Notification parsing (RFC 3464 / RFC 3463).
//
// This module is the reason the feature can claim to KNOW a message bounced
// rather than suspect it. Everything it returns is read out of the structured
// `message/delivery-status` part of the notice the receiving mail system sent
// back — not out of the subject line, not out of the human-readable blurb, and
// not out of the sender's address.
//
// A notice that carries no machine-readable report yields no verdict at all.
// The scanner records that it could not read it and moves on; no counter is
// touched. That is deliberate: a false suppression silently stops a real
// customer's mail forever, which is far worse than missing one bounce.
// ─────────────────────────────────────────────────────────────

export interface DsnRecipientReport {
  /** The address the report is about, from Final-Recipient (or Original-Recipient). */
  recipient: string
  /** DSN Action field: 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded'. */
  action: string
  /** RFC 3463 enhanced status, e.g. '5.1.1'. May be a 2.x.x/4.x.x code too —
      see classify() for which ones are acted on. */
  status: string
  /** The receiving server's verbatim refusal text, if it gave one. */
  diagnostic: string | null
  remoteMta: string | null
  /** Where `status` came from — recorded so a verdict can always be traced back. */
  statusSource: 'status_field' | 'diagnostic_code' | 'smtp_reply_code'
}

export interface ParsedDsn {
  /** One entry per recipient the notice reports on. Empty ⇒ nothing to act on. */
  reports: DsnRecipientReport[]
  /** Message-ID of the original message, recovered from the returned headers. */
  originalMessageId: string | null
  /** In-Reply-To / References on the notice itself — Gmail quotes the original here. */
  referencedMessageIds: string[]
  /** Gmail sets X-Failed-Recipients on its own bounces. Corroboration only. */
  failedRecipientsHeader: string[]
  /** True when a message/delivery-status part was found and understood. */
  hasReport: boolean
}

// ── Header handling ──────────────────────────────────────────

type Headers = Map<string, string[]>

/* Split a raw RFC 822 chunk into headers + body, unfolding continuation lines
   (a line starting with space/tab belongs to the header above it). */
function splitHeaders(raw: string): { headers: Headers; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  const sep = normalized.indexOf('\n\n')
  const headerBlock = sep === -1 ? normalized : normalized.slice(0, sep)
  const body = sep === -1 ? '' : normalized.slice(sep + 2)

  const headers: Headers = new Map()
  let current: string | null = null

  for (const line of headerBlock.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      // Folded continuation — a single space replaces the fold per RFC 5322.
      const list = headers.get(current)!
      list[list.length - 1] += ' ' + line.trim()
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    current = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!headers.has(current)) headers.set(current, [])
    headers.get(current)!.push(value)
  }

  return { headers, body }
}

function header(headers: Headers, name: string): string | null {
  const v = headers.get(name.toLowerCase())
  return v && v.length ? v[0] : null
}

interface ContentType {
  type: string
  params: Record<string, string>
}

function parseContentType(value: string | null): ContentType {
  if (!value) return { type: 'text/plain', params: {} }
  const [typePart, ...paramParts] = value.split(';')
  const params: Record<string, string> = {}
  for (const part of paramParts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    let val = part.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    params[key] = val
  }
  return { type: typePart.trim().toLowerCase(), params }
}

// ── Transfer encodings ───────────────────────────────────────

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '') // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function decodeBase64(input: string): string {
  try {
    const clean = input.replace(/[^A-Za-z0-9+/=]/g, '')
    const binary = atob(clean)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

function decodeBody(headers: Headers, body: string): string {
  const encoding = (header(headers, 'content-transfer-encoding') || '').toLowerCase().trim()
  if (encoding === 'base64') return decodeBase64(body)
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

// ── MIME walking ─────────────────────────────────────────────

interface MimePart {
  headers: Headers
  contentType: ContentType
  /** Decoded text for leaf parts. */
  body: string
}

/* Depth-limited recursive walk that flattens every leaf part of a message.
   Bounces nest — multipart/report inside multipart/mixed is common — and a
   report buried two levels down is still a report. */
function walkParts(raw: string, out: MimePart[], depth = 0): void {
  if (depth > 10) return
  const { headers, body } = splitHeaders(raw)
  const contentType = parseContentType(header(headers, 'content-type'))

  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary
    if (!boundary) return
    for (const section of splitOnBoundary(body, boundary)) {
      walkParts(section, out, depth + 1)
    }
    return
  }

  out.push({ headers, contentType, body: decodeBody(headers, body) })
}

/* Split a multipart body on its boundary delimiter. Everything before the
   first delimiter (the "preamble") and after the closing one is discarded. */
function splitOnBoundary(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`
  const sections: string[] = []
  const lines = body.split('\n')
  let current: string[] | null = null

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed === delimiter) {
      if (current) sections.push(current.join('\n'))
      current = []
      continue
    }
    if (trimmed === `${delimiter}--`) {
      if (current) sections.push(current.join('\n'))
      current = null
      break
    }
    if (current) current.push(line)
  }
  if (current) sections.push(current.join('\n'))

  return sections
}

// ── Field extraction ─────────────────────────────────────────

/* A DSN address field looks like `rfc822; user@example.com`. The type prefix
   is optional in practice, and some MTAs wrap the address in <>. */
function parseDsnAddress(value: string | null): string | null {
  if (!value) return null
  let v = value.trim()
  const semi = v.indexOf(';')
  if (semi !== -1) v = v.slice(semi + 1).trim()
  v = v.replace(/^<|>$/g, '').trim()
  // Guard against a mangled field producing a non-address we would then
  // suppress. Must look like exactly one address.
  const match = v.match(/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/)
  return match ? v.toLowerCase() : null
}

const ENHANCED_STATUS = /\b([245]\.\d{1,3}\.\d{1,3})\b/
const SMTP_REPLY_CODE = /\b([45]\d{2})\b/

/* Resolve the enhanced status code for one recipient report, in the order the
   standards make it authoritative:

     1. The DSN `Status:` field — RFC 3464 says this IS the machine-readable
        verdict, so it wins whenever present.
     2. An enhanced code embedded in `Diagnostic-Code:` — this is the receiving
        server's own SMTP reply, quoted verbatim ("smtp; 550-5.1.1 ..."), so
        reading the code out of it is transcription, not inference.
     3. A bare 5xx SMTP reply code with no enhanced code at all. RFC 5321
        already defines 5xx as a permanent failure, so this is still a fact,
        just a less specific one; it becomes '5.0.0'.

   Success and transient codes (2.x.x, 4.x.x) are parsed and returned too, so
   `reports` really is one entry per recipient the notice covers; deciding
   which of them matter is classify()'s job and the caller's, not this
   function's. The bare-reply-code fallback stays restricted to 5xx, because a
   2xx or 4xx reply with no enhanced code carries no permanent verdict worth
   reconstructing.

   Returns null when none of the three yields a code — the report is then
   dropped rather than guessed at. */
function resolveStatus(
  statusField: string | null,
  diagnostic: string | null
): { status: string; source: DsnRecipientReport['statusSource'] } | null {
  if (statusField) {
    const m = statusField.trim().match(/^([245]\.\d{1,3}\.\d{1,3})/)
    if (m) return { status: m[1], source: 'status_field' }
  }
  if (diagnostic) {
    const enhanced = diagnostic.match(ENHANCED_STATUS)
    if (enhanced) return { status: enhanced[1], source: 'diagnostic_code' }
    const reply = diagnostic.match(SMTP_REPLY_CODE)
    if (reply && reply[1].startsWith('5')) {
      return { status: '5.0.0', source: 'smtp_reply_code' }
    }
  }
  return null
}

/* Parse the per-recipient groups inside a message/delivery-status part. The
   part is a per-message field block, then one blank-line-separated block per
   recipient. We treat any block containing a Final-Recipient (or
   Original-Recipient) as a recipient block, which tolerates MTAs that put
   per-message fields in an unexpected order. */
function parseDeliveryStatusPart(body: string): DsnRecipientReport[] {
  const reports: DsnRecipientReport[] = []
  // Blocks are separated by a blank line; unfold each independently.
  const blocks = body.replace(/\r\n/g, '\n').split(/\n\s*\n/)

  for (const block of blocks) {
    if (!block.trim()) continue
    const { headers } = splitHeaders(block + '\n\n')

    const recipient =
      parseDsnAddress(header(headers, 'final-recipient')) ??
      parseDsnAddress(header(headers, 'original-recipient'))
    if (!recipient) continue

    const action = (header(headers, 'action') || '').trim().toLowerCase()
    const diagnosticRaw = header(headers, 'diagnostic-code')
    const diagnostic = diagnosticRaw ? diagnosticRaw.trim() : null

    const resolved = resolveStatus(header(headers, 'status'), diagnostic)
    if (!resolved) continue

    reports.push({
      recipient,
      action,
      status: resolved.status,
      diagnostic: diagnostic ? diagnostic.slice(0, 2000) : null,
      remoteMta: header(headers, 'remote-mta'),
      statusSource: resolved.source,
    })
  }

  return reports
}

function extractMessageIds(value: string | null): string[] {
  if (!value) return []
  const ids = value.match(/<[^<>\s]+>/g)
  return ids ? ids.map((id) => id.trim()) : []
}

// ── Public entry point ───────────────────────────────────────

/* Parse a full raw RFC 822 message (as returned by Gmail's format=raw) into
   the delivery reports it carries. `hasReport` is false for anything that is
   not a machine-readable DSN — including bounce-looking mail that only has a
   human-readable explanation. */
export function parseDsn(rawMessage: string): ParsedDsn {
  const parts: MimePart[] = []
  walkParts(rawMessage, parts)

  const { headers: topHeaders } = splitHeaders(rawMessage)

  const reports: DsnRecipientReport[] = []
  let originalMessageId: string | null = null
  let hasReport = false

  for (const part of parts) {
    if (part.contentType.type === 'message/delivery-status') {
      hasReport = true
      reports.push(...parseDeliveryStatusPart(part.body))
      continue
    }

    // The returned copy of the original message — either the whole thing
    // (message/rfc822) or just its headers (text/rfc822-headers). Either way
    // it gives us the Message-ID Gmail assigned when we sent it, which is the
    // strongest link back to our own campaign_sends row.
    if (
      part.contentType.type === 'message/rfc822' ||
      part.contentType.type === 'text/rfc822-headers'
    ) {
      const { headers: originalHeaders } = splitHeaders(part.body)
      const id = extractMessageIds(header(originalHeaders, 'message-id'))[0]
      if (id && !originalMessageId) originalMessageId = id
    }
  }

  const referencedMessageIds = [
    ...extractMessageIds(header(topHeaders, 'in-reply-to')),
    ...extractMessageIds(header(topHeaders, 'references')),
  ]

  // Gmail stamps this on bounces it generates. Never used to decide a verdict —
  // only to confirm that an address named in a report really was a recipient.
  const failedRecipientsHeader = (header(topHeaders, 'x-failed-recipients') || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes('@'))

  return {
    reports,
    originalMessageId,
    referencedMessageIds,
    failedRecipientsHeader,
    hasReport,
  }
}

/* The same rule the database applies (classify_delivery_status), duplicated
   here only so the scanner can skip work it knows will be rejected. The
   database remains the authority — every verdict is written by
   record_delivery_failure, never by this function. */
export function classify(status: string): 'bounced' | 'blocked' | null {
  if (!/^[45]\.\d+\.\d+$/.test(status)) return null
  if (status.startsWith('4.')) return null
  // 5.4.5 is "mail system congestion", and it is what Gmail returns when the
  // SENDING account has exhausted its daily quota. It describes our side of
  // the exchange, never the recipient's address, so it is not a strike.
  // Mirrors the same carve-out in classify_delivery_status().
  if (status === '5.4.5') return null
  if (status.startsWith('5.7.') || status === '5.3.0' || status === '5.5.0') return 'blocked'
  return 'bounced'
}
