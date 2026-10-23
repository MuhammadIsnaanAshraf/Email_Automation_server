// Reply classification fixtures. Run with:  deno test replies.test.ts
//
// A bounce lands in the same Gmail thread as the message that caused it, so
// the most important negative case is that a delivery notice is never taken
// for a reply. Out-of-office replies are the second: they must be recorded but
// never inflate the reply rate.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildReplyQuery, isAutoReply, isDeliveryNotice, parseAddress, pickSendForReply } from './replies.ts'

Deno.test('query excludes our own mail and looks everywhere', () => {
  const q = buildReplyQuery(1700000000.7)
  assert(q.includes('-from:me'))
  assert(q.includes('in:anywhere'))
  assert(q.includes('after:1700000000'))
})

Deno.test('parses the address out of a From header', () => {
  assertEquals(parseAddress('Jane Doe <Jane@Example.com>'), 'jane@example.com')
  assertEquals(parseAddress('bob@example.org'), 'bob@example.org')
  assertEquals(parseAddress('"Doe, Jane" <jane@x.io>'), 'jane@x.io')
  assertEquals(parseAddress('not an address'), null)
  assertEquals(parseAddress(undefined), null)
})

Deno.test('delivery notices are never replies', () => {
  assert(isDeliveryNotice({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }))
  assert(isDeliveryNotice({ from: 'postmaster@outlook.com' }))
  assert(isDeliveryNotice({ from: 'x@y.com', 'content-type': 'multipart/report; report-type=delivery-status; boundary=a' }))
  assert(isDeliveryNotice({ from: 'x@y.com', 'x-failed-recipients': 'z@y.com' }))
  assertEquals(isDeliveryNotice({ from: 'Jane <jane@example.com>', 'content-type': 'multipart/alternative' }), false)
})

Deno.test('recognizes autoresponders by header first', () => {
  assert(isAutoReply({ 'auto-submitted': 'auto-replied' }))
  assert(isAutoReply({ 'auto-submitted': 'auto-generated' }))
  assert(isAutoReply({ 'x-autoreply': 'yes' }))
  assert(isAutoReply({ 'x-auto-response-suppress': 'All' }) === false)
  assert(isAutoReply({ 'x-auto-response-suppress': 'OOF, AutoReply' }))
  assert(isAutoReply({ precedence: 'auto_reply' }))
})

Deno.test('falls back to the subject line', () => {
  assert(isAutoReply({ subject: 'Automatic reply: Quick question' }))
  assert(isAutoReply({ subject: 'Out of Office: Re: Hello' }))
  assert(isAutoReply({ subject: 'Abwesenheitsnotiz: Hallo' }))
  assert(isAutoReply({ subject: 'Réponse automatique : Bonjour' }))
})

Deno.test('a human reply is a reply', () => {
  assertEquals(isAutoReply({ subject: 'Re: Quick question', 'auto-submitted': 'no' }), false)
  assertEquals(isAutoReply({ subject: 'Re: Out of office next week?' }), false)
  assertEquals(isAutoReply({}), false)
})

Deno.test('attributes a reply to the latest send before it arrived', () => {
  const sends = [
    { id: 'a', campaign_id: 'c1', sent_at: '2026-01-01T10:00:00Z' },
    { id: 'b', campaign_id: 'c2', sent_at: '2026-01-05T10:00:00Z' },
  ]
  assertEquals(pickSendForReply(sends, Date.parse('2026-01-03T00:00:00Z'))?.id, 'a')
  assertEquals(pickSendForReply(sends, Date.parse('2026-01-06T00:00:00Z'))?.id, 'b')
  assertEquals(pickSendForReply(sends, Date.parse('2025-12-31T00:00:00Z')), null)
})
