// Fixture suite for the DSN parser. Run with:  deno test dsn.test.ts
//
// Every fixture is a real-world shape of delivery-status notice. They exist
// because the cost of getting this wrong is asymmetric: a missed bounce is an
// email that goes out once more than it should, while a false bounce silently
// blacklists a real customer forever. The negative cases (7, 8, 11) matter more
// than the positive ones.

import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { parseDsn, classify } from './dsn.ts'

function check(name: string, cond: boolean, detail?: unknown) {
  assert(cond, `${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
}

const CRLF = (s: string) => s.replace(/\n/g, '\r\n')

// ── 1. Gmail hard bounce: nonexistent mailbox (5.1.1) ────────
const gmailNoSuchUser = CRLF(`Delivered-To: sender@example.com
Received: by 2002:a05:6602 with SMTP id x1; Tue, 16 Sep 2025 03:11:02 -0700
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: sender@example.com
Subject: Delivery Status Notification (Failure)
Message-ID: <bounce-001@mx.google.com>
In-Reply-To: <CAF7original123@mail.gmail.com>
References: <CAF7original123@mail.gmail.com>
X-Failed-Recipients: nosuchuser@target.com
Content-Type: multipart/report; report-type=delivery-status; boundary="000000000000abc"
MIME-Version: 1.0

--000000000000abc
Content-Type: text/plain; charset="UTF-8"

** Address not found **

Your message wasn't delivered to nosuchuser@target.com because the address
couldn't be found, or is unable to receive mail.

--000000000000abc
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com
Arrival-Date: Tue, 16 Sep 2025 03:11:01 -0700
X-Original-Message-ID: <CAF7original123@mail.gmail.com>

Final-Recipient: rfc822; nosuchuser@target.com
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.target.com. (10.1.1.1)
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not
 exist. Please try double-checking the recipient's email address for typos.

--000000000000abc
Content-Type: message/rfc822
Content-Transfer-Encoding: 7bit

Message-ID: <CAF7original123@mail.gmail.com>
From: Sender <sender@example.com>
To: nosuchuser@target.com
Subject: Quick question

Hello there.

--000000000000abc--
`)

Deno.test('Gmail hard bounce (5.1.1) — nonexistent mailbox', () => {
  const r = parseDsn(gmailNoSuchUser)
  check('gmail 5.1.1: has report', r.hasReport)
  check('gmail 5.1.1: one recipient report', r.reports.length === 1, r.reports)
  check('gmail 5.1.1: recipient', r.reports[0]?.recipient === 'nosuchuser@target.com', r.reports[0])
  check('gmail 5.1.1: action failed', r.reports[0]?.action === 'failed')
  check('gmail 5.1.1: status 5.1.1', r.reports[0]?.status === '5.1.1')
  check('gmail 5.1.1: from Status field', r.reports[0]?.statusSource === 'status_field')
  check('gmail 5.1.1: diagnostic unfolded',
    (r.reports[0]?.diagnostic || '').includes('double-checking'), r.reports[0]?.diagnostic)
  check('gmail 5.1.1: classified bounced', classify(r.reports[0].status) === 'bounced')
  check('gmail 5.1.1: original message id',
    r.originalMessageId === '<CAF7original123@mail.gmail.com>', r.originalMessageId)
  check('gmail 5.1.1: referenced ids',
    r.referencedMessageIds.includes('<CAF7original123@mail.gmail.com>'), r.referencedMessageIds)
  check('gmail 5.1.1: X-Failed-Recipients',
    r.failedRecipientsHeader.includes('nosuchuser@target.com'), r.failedRecipientsHeader)
})

// ── 2. Spam block (5.7.1) → blocked, not bounced ──────────────
const spamBlock = CRLF(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: sender@example.com
Subject: Delivery Status Notification (Failure)
Message-ID: <bounce-002@mx.google.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd2"
MIME-Version: 1.0

--bnd2
Content-Type: text/plain

Message blocked.

--bnd2
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com

Final-Recipient: rfc822; realperson@corp.com
Action: failed
Status: 5.7.1
Diagnostic-Code: smtp; 550 5.7.1 Message rejected due to content restrictions

--bnd2--
`)

Deno.test('Spam block (5.7.1) classifies as blocked, not bounced', () => {
  const r = parseDsn(spamBlock)
  check('5.7.1: parsed', r.hasReport && r.reports.length === 1)
  check('5.7.1: classified blocked', classify(r.reports[0].status) === 'blocked', r.reports[0])
})

// ── 3. Transient 4.x.x must NOT count ────────────────────────
const transient = CRLF(`From: postmaster@target.com
To: sender@example.com
Subject: Delivery Status Notification (Delay)
Message-ID: <bounce-003@target.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd3"

--bnd3
Content-Type: message/delivery-status

Final-Recipient: rfc822; busy@target.com
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full

--bnd3--
`)

Deno.test('Transient 4.x.x is never a strike', () => {
  const r = parseDsn(transient)
  check('4.2.2: report present', r.hasReport && r.reports.length === 1)
  check('4.2.2: action is delayed', r.reports[0].action === 'delayed')
  check('4.2.2: classify returns null', classify(r.reports[0].status) === null)
})

// ── 4. Multiple recipients in one notice ─────────────────────
const multi = CRLF(`From: MAILER-DAEMON@target.com
To: sender@example.com
Subject: Undelivered Mail Returned to Sender
Message-ID: <bounce-004@target.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd4"

--bnd4
Content-Type: message/delivery-status

Reporting-MTA: dns; target.com

Final-Recipient: rfc822; gone@target.com
Original-Recipient: rfc822;gone@target.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <gone@target.com>: Recipient address rejected

Final-Recipient: rfc822; banned@target.com
Action: failed
Status: 5.7.606
Diagnostic-Code: smtp; 550 5.7.606 Access denied, banned sending IP

Final-Recipient: rfc822; ok@target.com
Action: delivered
Status: 2.0.0

--bnd4--
`)

Deno.test('One notice reporting several recipients', () => {
  const r = parseDsn(multi)
  check('multi: three reports', r.reports.length === 3, r.reports.map(x => x.recipient))
  const gone = r.reports.find(x => x.recipient === 'gone@target.com')
  const banned = r.reports.find(x => x.recipient === 'banned@target.com')
  const ok = r.reports.find(x => x.recipient === 'ok@target.com')
  check('multi: gone → bounced', classify(gone.status) === 'bounced')
  check('multi: banned 5.7.606 → blocked', classify(banned.status) === 'blocked', banned)
  check('multi: delivered has action delivered', ok.action === 'delivered')
  check('multi: delivered classify 2.0.0 → null', classify(ok.status) === null)
})

// ── 5. No Status: field — code must come from Diagnostic-Code ─
const noStatusField = CRLF(`From: MAILER-DAEMON@legacy.net
To: sender@example.com
Subject: failure notice
Message-ID: <bounce-005@legacy.net>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd5"

--bnd5
Content-Type: message/delivery-status

Final-Recipient: rfc822; old@legacy.net
Action: failed
Diagnostic-Code: smtp; 550-5.1.10 RESOLVER.ADR.RecipientNotFound

--bnd5--
`)

Deno.test('Missing Status: field — code read from Diagnostic-Code', () => {
  const r = parseDsn(noStatusField)
  check('no Status:, code from diagnostic', r.reports[0]?.status === '5.1.10', r.reports[0])
  check('no Status:, source recorded', r.reports[0]?.statusSource === 'diagnostic_code')
  check('no Status:, classified bounced', classify(r.reports[0].status) === 'bounced')
})

// ── 6. Bare SMTP reply code only ─────────────────────────────
const bareCode = CRLF(`From: MAILER-DAEMON@old.example
To: sender@example.com
Subject: Returned mail
Message-ID: <bounce-006@old.example>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd6"

--bnd6
Content-Type: message/delivery-status

Final-Recipient: rfc822; someone@old.example
Action: failed
Diagnostic-Code: smtp; 550 Requested action not taken: mailbox unavailable

--bnd6--
`)

Deno.test('Bare SMTP reply code with no enhanced status', () => {
  const r = parseDsn(bareCode)
  check('bare 550 → 5.0.0', r.reports[0]?.status === '5.0.0', r.reports[0])
  check('bare 550 source recorded', r.reports[0]?.statusSource === 'smtp_reply_code')
  check('bare 550 classified bounced', classify(r.reports[0].status) === 'bounced')
})

// ── 7. Auto-reply / vacation mail is NOT a bounce ────────────
const autoReply = CRLF(`From: Jane <jane@target.com>
To: sender@example.com
Subject: Automatic reply: Undeliverable message about your delivery failure
Message-ID: <auto-007@target.com>
Content-Type: text/plain

I am out of the office. Your message could not be delivered to me today.
Status: 5.1.1 (this text appears in the body but is not a DSN)
`)

Deno.test('Out-of-office reply is not a bounce', () => {
  const r = parseDsn(autoReply)
  check('auto-reply: hasReport false', r.hasReport === false, r)
  check('auto-reply: no reports', r.reports.length === 0)
})

// ── 8. Human-readable-only bounce, no machine report ─────────
const humanOnly = CRLF(`From: postmaster@target.com
To: sender@example.com
Subject: Delivery Failure
Message-ID: <bounce-008@target.com>
Content-Type: text/plain

Sorry, we were unable to deliver your message to user@target.com.
The mailbox does not exist. 550 5.1.1
`)

Deno.test('Human-readable-only failure yields no verdict', () => {
  const r = parseDsn(humanOnly)
  check('human-only: hasReport false', r.hasReport === false)
  check('human-only: yields no verdict', r.reports.length === 0)
})

// ── 9. base64-encoded delivery-status part ───────────────────
const b64Status = btoa(
  'Final-Recipient: rfc822; b64@target.com\r\nAction: failed\r\nStatus: 5.2.1\r\n'
)
const base64Part = CRLF(`From: MAILER-DAEMON@target.com
To: sender@example.com
Subject: Undeliverable
Message-ID: <bounce-009@target.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd9"

--bnd9
Content-Type: message/delivery-status
Content-Transfer-Encoding: base64

${b64Status}
--bnd9--
`)

Deno.test('base64-encoded delivery-status part', () => {
  const r = parseDsn(base64Part)
  check('base64 part decoded', r.reports[0]?.recipient === 'b64@target.com', r.reports)
  check('base64 part status', r.reports[0]?.status === '5.2.1')
  check('base64 5.2.1 → bounced', classify('5.2.1') === 'bounced')
})

// ── 10. Nested multipart (report inside mixed) ───────────────
const nested = CRLF(`From: MAILER-DAEMON@target.com
To: sender@example.com
Subject: Undeliverable
Message-ID: <bounce-010@target.com>
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/report; report-type=delivery-status; boundary="inner"

--inner
Content-Type: text/plain

Could not deliver.

--inner
Content-Type: message/delivery-status

Final-Recipient: rfc822; nested@target.com
Action: failed
Status: 5.7.26

--inner--

--outer--
`)

Deno.test('multipart/report nested inside multipart/mixed', () => {
  const r = parseDsn(nested)
  check('nested: found report', r.hasReport && r.reports.length === 1, r.reports)
  check('nested: 5.7.26 → blocked', classify(r.reports[0].status) === 'blocked')
})

// ── 11. Malformed Final-Recipient must not produce an address ─
const malformed = CRLF(`From: MAILER-DAEMON@target.com
To: sender@example.com
Subject: Undeliverable
Message-ID: <bounce-011@target.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd11"

--bnd11
Content-Type: message/delivery-status

Final-Recipient: rfc822; unknown
Action: failed
Status: 5.1.1

Final-Recipient: rfc822; a@b.com, c@d.com
Action: failed
Status: 5.1.1

--bnd11--
`)

Deno.test('Malformed Final-Recipient never produces an address', () => {
  const r = parseDsn(malformed)
  check('malformed addresses dropped', r.reports.length === 0, r.reports)
})

// ── 12. Angle-bracketed + mixed-case address normalizes ──────
const bracketed = CRLF(`From: MAILER-DAEMON@target.com
To: sender@example.com
Subject: Undeliverable
Message-ID: <bounce-012@target.com>
Content-Type: multipart/report; report-type=delivery-status; boundary="bnd12"

--bnd12
Content-Type: message/delivery-status

Final-Recipient: rfc822; <John.Doe@Target.COM>
Action: failed
Status: 5.1.1

--bnd12--
`)

Deno.test('Angle-bracketed, mixed-case address is normalized', () => {
  const r = parseDsn(bracketed)
  check('bracketed address normalized',
    r.reports[0]?.recipient === 'john.doe@target.com', r.reports[0])
})

// ── 13. classify() boundaries ────────────────────────────────
Deno.test('classify() maps enhanced status codes to verdicts', () => {
  check('classify 5.1.1 bounced', classify('5.1.1') === 'bounced')
  check('classify 5.2.2 bounced', classify('5.2.2') === 'bounced')
  check('classify 5.4.4 bounced', classify('5.4.4') === 'bounced')
  check('classify 5.7.1 blocked', classify('5.7.1') === 'blocked')
  check('classify 5.7.606 blocked', classify('5.7.606') === 'blocked')
  check('classify 5.3.0 blocked', classify('5.3.0') === 'blocked')
  check('classify 5.5.0 blocked', classify('5.5.0') === 'blocked')
  check('classify 4.7.1 null', classify('4.7.1') === null)
  // The sender's own quota must never be charged to a recipient.
  check('classify 5.4.5 null (our quota, not their address)', classify('5.4.5') === null)
  check('classify 2.0.0 null', classify('2.0.0') === null)
  check('classify garbage null', classify('nope') === null)
  check('classify empty null', classify('') === null)
})
