// Engagement tracking — the parts shared by the sender (which instruments the
// HTML) and the `track` function (which receives the hits).
//
//   open  → a 1×1 image at  <base>/o/<sendId>/<sig>.gif
//   click → each link becomes <base>/c/<sendId>/<sig>?u=<original url>
//
// Both are HMAC-signed. For opens that just stops forged hits; for clicks it is
// what keeps the redirect from being an open redirect — without a valid
// signature over the exact target URL, `track` refuses to redirect anywhere.

export type FilterReason = 'scanner' | 'prefetch' | 'privacy_proxy' | 'head_request'

export interface TrackingConfig {
  /** Public base URL of the `track` function, no trailing slash. */
  baseUrl: string
  key: CryptoKey
}

/* The signing key. TRACKING_SECRET when set; otherwise TOKEN_ENCRYPTION_KEY,
   which both send-tick and track already have — so tracking works without a
   new secret. The label keeps the two uses of that key from ever colliding. */
export async function importTrackingKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`zenviqo-tracking-v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export function resolveTrackingBaseUrl(explicit: string | undefined, supabaseUrl: string): string {
  const base = (explicit && explicit.trim()) || `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/track`
  return base.replace(/\/+$/, '')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 128 bits of the HMAC is plenty for a URL token and keeps links short.
async function sign(key: CryptoKey, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return base64Url(new Uint8Array(mac).slice(0, 16))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const signOpen = (key: CryptoKey, sendId: string) => sign(key, `o:${sendId}`)
export const signClick = (key: CryptoKey, sendId: string, url: string) => sign(key, `c:${sendId}:${url}`)

export async function verifyOpen(key: CryptoKey, sendId: string, sig: string): Promise<boolean> {
  return timingSafeEqual(await signOpen(key, sendId), sig)
}
export async function verifyClick(key: CryptoKey, sendId: string, url: string, sig: string): Promise<boolean> {
  return timingSafeEqual(await signClick(key, sendId, url), sig)
}

export async function openPixelUrl(cfg: TrackingConfig, sendId: string): Promise<string> {
  return `${cfg.baseUrl}/o/${sendId}/${await signOpen(cfg.key, sendId)}.gif`
}

export async function clickUrl(cfg: TrackingConfig, sendId: string, target: string): Promise<string> {
  return `${cfg.baseUrl}/c/${sendId}/${await signClick(cfg.key, sendId, target)}?u=${encodeURIComponent(target)}`
}

/* Only real web links are worth tracking. mailto:, tel:, anchors and anything
   unparseable are left exactly as written. */
export function isTrackableUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Attribute values in the editor's HTML are entity-escaped (`&amp;` in a query
// string). The redirect must go to the URL the author meant, not the escaped form.
function decodeAttr(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const ANCHOR_HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])([\s\S]*?)\2/gi

/* Rewrite every trackable <a href> in the body to go through the click
   redirect. Links already pointing at the tracker are left alone, so running
   this twice is harmless. */
export async function rewriteLinks(html: string, sendId: string, cfg: TrackingConfig): Promise<string> {
  const matches = [...html.matchAll(ANCHOR_HREF_RE)]
  if (!matches.length) return html

  let out = ''
  let last = 0
  for (const m of matches) {
    const [whole, prefix, _quote, rawHref] = m
    const start = m.index ?? 0
    const target = decodeAttr(rawHref.trim())
    out += html.slice(last, start)
    if (isTrackableUrl(target) && !target.startsWith(cfg.baseUrl)) {
      out += `${prefix}"${escapeAttr(await clickUrl(cfg, sendId, target))}"`
    } else {
      out += whole
    }
    last = start + whole.length
  }
  return out + html.slice(last)
}

/* Append the open pixel. Sized 1×1 rather than display:none — several clients
   skip loading hidden images, which would silently undercount opens. */
export async function injectOpenPixel(html: string, sendId: string, cfg: TrackingConfig): Promise<string> {
  const img =
    `<img src="${escapeAttr(await openPixelUrl(cfg, sendId))}" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden" />`
  const closeBody = html.search(/<\/body\s*>/i)
  return closeBody === -1 ? html + img : html.slice(0, closeBody) + img + html.slice(closeBody)
}

/* Security scanners and link expanders. Matched against the User-Agent of a
   hit; a match is recorded but never counted. Deliberately does not include
   "Microsoft Office/" — that is Outlook desktop loading images for a real
   reader. `ms-office` / "Existence Discovery" are Office apps probing a link
   before handing it to the browser, which then makes its own (counted) hit. */
const SCANNER_UA = new RegExp(
  [
    '(?:^|[^a-z])bot\\b', 'bot/', 'crawler', 'spider', 'preview', 'python-requests', 'python-urllib', 'curl/', 'wget',
    'go-http-client', 'java/', 'okhttp', 'axios', 'node-fetch', 'undici', 'headless', 'phantomjs',
    'barracuda', 'mimecast', 'proofpoint', 'safelinks', 'existence discovery', '\\bms-office\\b',
    'symantec', 'forcepoint', 'trendmicro', 'sophos', 'fortiguard', 'messagelabs', 'zscaler',
    'ironport', 'appriver', 'scanner', 'facebookexternalhit', 'slackbot', 'linkexpanding',
    'whatsapp', 'skypeuripreview', 'discordbot', 'telegrambot',
  ].join('|'),
  'i'
)

/* Decide from the request alone whether a hit is machine traffic. The
   time-since-send rule needs sent_at, so it lives in record_engagement_event. */
export function classifyHit(kind: 'open' | 'click', method: string, userAgent: string | null): FilterReason | null {
  if (method.toUpperCase() === 'HEAD') return 'head_request'
  const ua = (userAgent || '').trim()
  // Every real mail client and image proxy identifies itself.
  if (!ua) return 'scanner'
  // Apple Mail Privacy Protection fetches all images through a proxy on
  // delivery, identifying itself only as a bare "Mozilla/5.0". It says nothing
  // about whether the message was read.
  if (kind === 'open' && ua === 'Mozilla/5.0') return 'privacy_proxy'
  if (SCANNER_UA.test(ua)) return 'scanner'
  return null
}
