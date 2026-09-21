// Guard rail for the synchronous-rejection path. Run with:  deno test gmail.test.ts
//
// When Gmail refuses a send outright it quotes the receiving server's SMTP
// reply back at us, and that reply is real bounce evidence. The danger is that
// Gmail's OWN failures — daily quota, rate limits, bad auth — arrive through
// the same channel carrying perfectly valid-looking 5.x.x codes. Charging one
// of those to a recipient would blacklist a working address because the sender
// hit a limit, which is the single worst outcome this feature can produce.
//
// Hence the negative cases below: they are the point of the test, not padding.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { extractEnhancedStatus } from './gmail.ts'

Deno.test("counts codes that describe the recipient's mailbox", () => {
  assertEquals(
    extractEnhancedStatus(
      '{"error":{"code":550,"message":"550-5.1.1 The email account that you tried to reach does not exist."}}'
    ),
    '5.1.1'
  )
  assertEquals(
    extractEnhancedStatus('550 5.2.1 The user you are trying to contact is not accepting mail'),
    '5.2.1'
  )
  assertEquals(extractEnhancedStatus('RESOLVER.ADR.RecipientNotFound 5.1.10'), '5.1.10')
})

Deno.test("never counts the sender's own failures", () => {
  // The important one: Gmail's daily sending limit. Left unguarded, two busy
  // days would permanently suppress a perfectly good address.
  assertEquals(
    extractEnhancedStatus('{"error":{"message":"550 5.4.5 Daily user sending limit exceeded."}}'),
    null
  )
  assertEquals(extractEnhancedStatus('421 4.7.0 Try again later'), null)
  assertEquals(extractEnhancedStatus('550 5.7.0 Mail relay denied'), null)
  assertEquals(extractEnhancedStatus('{"error":{"code":429,"message":"User-rate limit exceeded"}}'), null)
  assertEquals(extractEnhancedStatus('{"error":"invalid_grant"}'), null)
})

Deno.test('handles empty and absent bodies', () => {
  assertEquals(extractEnhancedStatus(''), null)
  assertEquals(extractEnhancedStatus(null), null)
  assertEquals(extractEnhancedStatus('no codes in here at all'), null)
})

Deno.test('prefers the recipient-scoped code over a generic one', () => {
  // Gmail sometimes leads with a generic code and gives the specific one after.
  assertEquals(extractEnhancedStatus('550 5.0.0 rejected; 5.1.1 unknown user'), '5.1.1')
})
