// Engagement tracking guard rails. Run with:  deno test tracking.test.ts
//
// The HTML rewrite runs on every tracked send, so the cases that matter most
// are the ones that must come out UNCHANGED: mailto/tel/anchor links, and the
// escaped query strings a rich-text editor produces. And the signature is the
// only thing standing between the click redirect and an open redirect.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  importTrackingKey,
  resolveTrackingBaseUrl,
  rewriteLinks,
  injectOpenPixel,
  verifyOpen,
  verifyClick,
  classifyHit,
  type TrackingConfig,
} from './tracking.ts'

const SEND = '3f2b8c1e-9a4d-4e6f-8b21-0c5d7e9fa123'
const BASE = 'https://ref.supabase.co/functions/v1/track'

async function cfg(): Promise<TrackingConfig> {
  return { baseUrl: BASE, key: await importTrackingKey('test-secret') }
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}

Deno.test('base URL defaults to the project track function', () => {
  assertEquals(resolveTrackingBaseUrl(undefined, 'https://ref.supabase.co/'), BASE)
  assertEquals(resolveTrackingBaseUrl('https://t.example.com/', 'https://ref.supabase.co'), 'https://t.example.com')
})

Deno.test('rewrites http(s) links to a signed redirect of the ORIGINAL url', async () => {
  const c = await cfg()
  const html = `<p>Hi <a href="https://example.com/a?x=1&amp;y=2">there</a> and <a class="b" href='http://x.io'>x</a></p>`
  const out = await rewriteLinks(html, SEND, c)
  const [first, second] = hrefs(out)

  const u1 = new URL(first)
  assert(first.startsWith(`${BASE}/c/${SEND}/`))
  // The entity-escaped &amp; must be decoded before signing, or the recipient
  // lands on a URL with a literal "&amp;" in it.
  assertEquals(u1.searchParams.get('u'), 'https://example.com/a?x=1&y=2')
  const sig = u1.pathname.split('/').pop()!
  assert(await verifyClick(c.key, SEND, 'https://example.com/a?x=1&y=2', sig))
  assertEquals(new URL(second).searchParams.get('u'), 'http://x.io')
  assert(out.includes('class="b"'))
  assert(out.includes('>there</a>'))
})

Deno.test('leaves non-web links exactly as written', async () => {
  const c = await cfg()
  const html = `<a href="mailto:a@b.com">m</a><a href="tel:+1">t</a><a href="#top">#</a><a href="">e</a><a name="x">n</a>`
  assertEquals(await rewriteLinks(html, SEND, c), html)
})

Deno.test('is idempotent — never double-wraps a tracked link', async () => {
  const c = await cfg()
  const once = await rewriteLinks(`<a href="https://example.com">x</a>`, SEND, c)
  assertEquals(await rewriteLinks(once, SEND, c), once)
})

Deno.test('signature is bound to the send and the exact target', async () => {
  const c = await cfg()
  const out = await rewriteLinks(`<a href="https://example.com">x</a>`, SEND, c)
  const sig = new URL(hrefs(out)[0]).pathname.split('/').pop()!
  assertEquals(await verifyClick(c.key, SEND, 'https://evil.example', sig), false)
  assertEquals(await verifyClick(c.key, '00000000-0000-4000-8000-000000000000', 'https://example.com', sig), false)
  const other = await importTrackingKey('other-secret')
  assertEquals(await verifyClick(other, SEND, 'https://example.com', sig), false)
})

Deno.test('open pixel goes before </body>, or at the end without one', async () => {
  const c = await cfg()
  const withBody = await injectOpenPixel('<html><body><p>x</p></body></html>', SEND, c)
  assert(/<img [^>]*\/o\/[^"]+\.gif"[^>]*\/><\/body>/.test(withBody))
  const fragment = await injectOpenPixel('<p>x</p>', SEND, c)
  assert(fragment.startsWith('<p>x</p><img '))

  const src = fragment.match(/src="([^"]+)"/)![1]
  const sig = src.split('/').pop()!.replace(/\.gif$/, '')
  assert(await verifyOpen(c.key, SEND, sig))
})

Deno.test('counts real mail clients and image proxies', () => {
  const real = [
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
    'YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17126; Pro)',
    'Mozilla/5.0 (Linux; Android 13; CUBOT X19) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
  ]
  for (const ua of real) assertEquals(classifyHit('open', 'GET', ua), null, ua)
})

Deno.test('sets aside scanners, probes and privacy proxies', () => {
  assertEquals(classifyHit('open', 'GET', 'Mozilla/5.0'), 'privacy_proxy')
  assertEquals(classifyHit('click', 'HEAD', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120'), 'head_request')
  assertEquals(classifyHit('click', 'GET', ''), 'scanner')
  assertEquals(classifyHit('click', 'GET', null), 'scanner')
  assertEquals(classifyHit('click', 'GET', 'Microsoft Office Existence Discovery'), 'scanner')
  assertEquals(classifyHit('click', 'GET', 'Mozilla/4.0 (compatible; ms-office; MSOffice 16)'), 'scanner')
  assertEquals(classifyHit('click', 'GET', 'python-requests/2.31.0'), 'scanner')
  assertEquals(classifyHit('click', 'GET', 'Mozilla/5.0 (compatible; Googlebot/2.1)'), 'scanner')
  assertEquals(classifyHit('click', 'GET', 'Barracuda Sentinel (EE)'), 'scanner')
})
