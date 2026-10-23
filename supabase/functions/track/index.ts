// ─────────────────────────────────────────────────────────────
// Zenviqo — Engagement tracker (Supabase Edge Function)
//
// Public endpoint hit by recipients' mail clients, never by the app:
//
//   GET <base>/o/<sendId>/<sig>.gif          → records an open, returns a 1×1 GIF
//   GET <base>/c/<sendId>/<sig>?u=<url>      → records a click, 302s to <url>
//
// Deployed with verify_jwt = false (a mail client has no Supabase session).
// Every URL is HMAC-signed by send-tick; an unsigned or tampered open is
// ignored, and an unsigned click is refused outright rather than redirected,
// so this can never be used as an open redirect.
//
// The response never waits on the database: the pixel/redirect goes back
// immediately and the event is written in the background (EdgeRuntime.waitUntil).
// A slow insert must not make a recipient's click feel broken.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2'
import { importTrackingKey, verifyOpen, verifyClick, isTrackableUrl, classifyHit } from '../send-tick/tracking.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TRACKING_SECRET = Deno.env.get('TRACKING_SECRET') || Deno.env.get('TOKEN_ENCRYPTION_KEY') || ''
// Hits closer than this to the send are scanners fetching on delivery.
const PREFETCH_SECONDS = Number(Deno.env.get('TRACK_PREFETCH_SECONDS') ?? '10')

console.log('[track] module init; env present:', {
  SUPABASE_URL: !!SUPABASE_URL,
  SERVICE_ROLE: !!SERVICE_ROLE,
  TRACKING_SECRET: !!TRACKING_SECRET,
})

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const keyPromise = importTrackingKey(TRACKING_SECRET)

// 42-byte transparent GIF.
const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0)
)

const NO_CACHE = {
  // Caching the pixel would hide every open after the first.
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

function pixelResponse(): Response {
  return new Response(PIXEL, {
    status: 200,
    headers: { 'Content-Type': 'image/gif', 'Content-Length': String(PIXEL.length), ...NO_CACHE },
  })
}

const PATH_RE = /\/(o|c)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9_-]{16,})(?:\.gif)?\/?$/i

function inBackground(work: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) runtime.waitUntil(work)
  else work.catch(() => {})
}

async function record(sendId: string, kind: 'open' | 'click', req: Request, url: string | null) {
  const userAgent = req.headers.get('user-agent')
  const { error } = await supabase.rpc('record_engagement_event', {
    p_send_id: sendId,
    p_kind: kind,
    p_url: url,
    p_user_agent: userAgent,
    p_filter_reason: classifyHit(kind, req.method, userAgent),
    p_occurred_at: new Date().toISOString(),
    p_prefetch_seconds: PREFETCH_SECONDS,
  })
  if (error) console.error('[track] record_engagement_event failed:', { sendId, kind, error })
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }

  const reqUrl = new URL(req.url)
  const match = reqUrl.pathname.match(PATH_RE)

  if (!match) {
    // Anything that looks like it wanted an image still gets one, so a mangled
    // pixel URL never renders as a broken-image icon in someone's inbox.
    return reqUrl.pathname.endsWith('.gif') ? pixelResponse() : new Response('Not found', { status: 404 })
  }

  const [, kind, sendId, sig] = match
  const key = await keyPromise

  if (kind === 'o') {
    if (TRACKING_SECRET && (await verifyOpen(key, sendId.toLowerCase(), sig))) {
      inBackground(record(sendId.toLowerCase(), 'open', req, null))
    }
    return pixelResponse()
  }

  const target = reqUrl.searchParams.get('u') || ''
  const valid =
    !!TRACKING_SECRET &&
    isTrackableUrl(target) &&
    (await verifyClick(key, sendId.toLowerCase(), target, sig))

  if (!valid) {
    return new Response('This link is invalid or has expired.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE },
    })
  }

  inBackground(record(sendId.toLowerCase(), 'click', req, target))
  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Referrer-Policy': 'no-referrer', ...NO_CACHE },
  })
})
