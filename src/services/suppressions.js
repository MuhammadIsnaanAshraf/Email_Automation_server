import { supabase } from '../lib/supabase.js'

/* The do-not-send list: addresses this account may never email again.

   Nothing in this file decides that an address should be suppressed. That
   judgement belongs to the bounce scanner, which reads the delivery-failure
   notices the receiving servers actually sent, and to record_delivery_failure()
   in the database, which owns the counters and the thresholds. This module
   reads that state, exposes it to the app, and offers the two manual overrides
   a human needs: add an address by hand, and release one that was suppressed in
   error.

   Thresholds (enforced in 20240118000000_bounce_blocking.sql):
     2 hard bounces ever                       → suppressed
     3 blocks with no confirmed delivery between → suppressed */

export class SuppressionError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SuppressionError'
    this.status = status
  }
}

const SORTABLE = new Set([
  'email',
  'status',
  'reason',
  'bounce_count',
  'block_count',
  'last_failure_at',
  'suppressed_at',
])

function normalize(email) {
  return String(email || '').trim().toLowerCase()
}

/* Escape a search term for a PostgREST `.or(...)` filter — same rules as
   lists.js: commas and parens delimit the expression, % and _ are wildcards. */
function sanitizeSearch(raw) {
  return String(raw)
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim()
}

/* Paginated view of the list. `filter`:
     'suppressed' — addresses that can no longer be emailed (the default view)
     'at_risk'    — addresses with failures on record but still under threshold
     'all'        — everything we've ever recorded a failure for */
export async function getSuppressions(
  userId,
  { page = 1, pageSize = 50, filter = 'suppressed', search = '', sort = 'last_failure_at', dir = 'desc' } = {}
) {
  const sortCol = SORTABLE.has(sort) ? sort : 'last_failure_at'
  const ascending = dir !== 'desc'

  let query = supabase
    .from('email_suppressions')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)

  if (filter === 'suppressed') query = query.eq('status', 'suppressed')
  else if (filter === 'at_risk') query = query.eq('status', 'active')

  const term = sanitizeSearch(search)
  if (term) query = query.ilike('email', `%${term}%`)

  const from = (page - 1) * pageSize
  const { data, error, count } = await query
    .order(sortCol, { ascending, nullsFirst: false })
    .order('normalized_email', { ascending: true })
    .range(from, from + pageSize - 1)

  if (error) throw error
  return { suppressions: data || [], total: count || 0, page, pageSize, filter, search, sort, dir }
}

/* Headline counts for the dashboard. `atRisk` is the useful early warning: an
   address sitting on one bounce, or two consecutive blocks, is one more failure
   away from being cut off for good. */
export async function getSuppressionStats(userId) {
  const { data, error } = await supabase
    .from('email_suppressions')
    .select('status, reason, bounce_count, block_count, consecutive_block_count')
    .eq('user_id', userId)
  if (error) throw error

  const stats = {
    total: 0,
    suppressed: 0,
    bounced: 0,
    blocked: 0,
    manual: 0,
    atRisk: 0,
    totalBounceEvents: 0,
    totalBlockEvents: 0,
  }

  for (const row of data || []) {
    stats.total++
    stats.totalBounceEvents += row.bounce_count || 0
    stats.totalBlockEvents += row.block_count || 0
    if (row.status === 'suppressed') {
      stats.suppressed++
      if (row.reason === 'bounced') stats.bounced++
      else if (row.reason === 'blocked') stats.blocked++
      else stats.manual++
    } else if ((row.bounce_count || 0) > 0 || (row.consecutive_block_count || 0) > 0) {
      stats.atRisk++
    }
  }

  return stats
}

/* Everything on record for one address: its counters plus the individual
   failure notices behind them, newest first. This is the "why is this
   suppressed?" answer — each event carries the receiving server's own status
   code and diagnostic text, so the user sees the evidence rather than our
   conclusion. */
export async function getSuppressionDetail(userId, email) {
  const normalized = normalize(email)
  if (!normalized) throw new SuppressionError('An email address is required.', 422)

  const { data: suppression } = await supabase
    .from('email_suppressions')
    .select('*')
    .eq('user_id', userId)
    .eq('normalized_email', normalized)
    .maybeSingle()

  const { data: events, error: eventsErr } = await supabase
    .from('email_delivery_events')
    .select('*, campaign:campaigns(id,name)')
    .eq('user_id', userId)
    .eq('normalized_email', normalized)
    .order('reported_at', { ascending: false })
    .limit(50)
  if (eventsErr) throw eventsErr

  // Which uploaded lists this address sits in, so the user can see the blast
  // radius of a suppression.
  const { data: rows, error: rowsErr } = await supabase
    .from('recipients')
    .select('list_id, delivery_state, suppressed_at, list:recipient_lists(id,name)')
    .eq('user_id', userId)
    .eq('normalized_email', normalized)
    .limit(200)
  if (rowsErr) throw rowsErr

  return {
    email: suppression?.email || normalized,
    suppression: suppression || null,
    events: events || [],
    lists: (rows || []).map((r) => ({
      id: r.list?.id || r.list_id,
      name: r.list?.name || null,
      deliveryState: r.delivery_state,
      suppressedAt: r.suppressed_at,
    })),
  }
}

/* Add an address by hand. Goes through the same database function the scanner
   uses, so a manual entry pulls the address out of every queue and marks every
   sheet row exactly as an automatic one does. */
export async function suppressAddress(userId, email, reason = 'manual') {
  const normalized = normalize(email)
  if (!normalized.includes('@')) {
    throw new SuppressionError('That does not look like an email address.', 422)
  }
  const allowed = new Set(['manual', 'bounced', 'blocked'])
  const { data, error } = await supabase.rpc('set_suppression', {
    p_user_id: userId,
    p_email: normalized,
    p_suppressed: true,
    p_reason: allowed.has(reason) ? reason : 'manual',
  })
  if (error) throw error
  if (data && data.ok === false) {
    throw new SuppressionError(data.error || 'Could not suppress that address.', 422)
  }
  return data
}

/* Lift a suppression. The counters are zeroed rather than left in place: a user
   who says an address is fine should get a genuinely clean slate, not an
   address that re-suppresses on its very next hiccup. If it really is dead, it
   will bounce twice again and come straight back. */
export async function releaseAddress(userId, email) {
  const normalized = normalize(email)
  if (!normalized) throw new SuppressionError('An email address is required.', 422)

  const { data, error } = await supabase.rpc('set_suppression', {
    p_user_id: userId,
    p_email: normalized,
    p_suppressed: false,
  })
  if (error) throw error
  return data
}

/* Filter a set of recipient rows down to the ones still mailable.

   Used at schedule time so a campaign never books sends it would only have to
   throw away. It is an optimization, not the safeguard: claim_due_sends()
   removes suppressed addresses from the queue no matter how they got there, so
   a list uploaded after this ran, or an address suppressed tomorrow, is still
   covered. */
export async function partitionSuppressed(userId, recipients) {
  if (!recipients.length) return { mailable: [], suppressed: [] }

  const addresses = [...new Set(recipients.map((r) => normalize(r.email)).filter(Boolean))]

  // PostgREST puts the filter in the URL, so a 50k-row list has to be asked
  // for in batches or the request line blows past the server's limit.
  const CHUNK = 500
  const blocked = new Map()
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('email_suppressions')
      .select('normalized_email, reason')
      .eq('user_id', userId)
      .eq('status', 'suppressed')
      .in('normalized_email', addresses.slice(i, i + CHUNK))
    if (error) throw error
    for (const row of data || []) blocked.set(row.normalized_email, row.reason)
  }

  if (blocked.size === 0) return { mailable: recipients, suppressed: [] }

  const mailable = []
  const suppressed = []
  for (const r of recipients) {
    const reason = blocked.get(normalize(r.email))
    if (reason) suppressed.push({ ...r, suppressionReason: reason })
    else mailable.push(r)
  }
  return { mailable, suppressed }
}

/* Per-account scanner health, for the settings page. `missing_scope` is the
   one a user can act on: it means the account connected before Gmail read
   access was requested, so nothing can be detected until they reconnect. */
export async function getBounceScanState(userId) {
  const { data, error } = await supabase
    .from('bounce_scan_state')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data || null
}
