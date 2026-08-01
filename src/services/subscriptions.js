import { supabase } from '../lib/supabase.js'

export class SubscriptionError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SubscriptionError'
    this.status = status
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const SUBSCRIPTION_PERIOD_DAYS = 30

/* Turn a user_subscription_status row (or null, for a user who has never
   paid) into the shape both the admin and user-facing UIs want: a plain
   active/expired flag plus a signed day-count so callers don't each redo
   this arithmetic (and don't each pick a different rounding rule). */
function toStatus(row) {
  if (!row) {
    return {
      active: false,
      neverSubscribed: true,
      periodStart: null,
      periodEnd: null,
      daysRemaining: 0,
      daysExpiredAgo: null,
      amount: null,
      currency: null,
      paymentMethod: null,
      lastActivatedAt: null,
    }
  }

  const expiresAt = new Date(row.period_end).getTime()
  const msLeft = expiresAt - Date.now()
  const active = msLeft > 0

  return {
    active,
    neverSubscribed: false,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    // Ceil so "5 minutes left" reads as 1 day left, not 0 — matches how a
    // human counts "days remaining" (today still counts).
    daysRemaining: active ? Math.ceil(msLeft / DAY_MS) : 0,
    daysExpiredAgo: active ? null : Math.floor(-msLeft / DAY_MS),
    amount: row.amount,
    currency: row.currency,
    paymentMethod: row.payment_method,
    lastActivatedAt: row.last_activated_at,
  }
}

async function getLatestPayment(userId) {
  const { data, error } = await supabase
    .from('user_subscription_status')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new SubscriptionError(error.message, 500)
  return data
}

export async function getSubscriptionStatus(userId) {
  return toStatus(await getLatestPayment(userId))
}

/* Real-time gate for paid features — no cached flag, always the current
   truth: does this user have a payment row whose period_end is still in the
   future, right now. Callers should treat "true" as the only "yes". */
export async function hasActiveSubscription(userId) {
  const latest = await getLatestPayment(userId)
  return !!latest && new Date(latest.period_end).getTime() > Date.now()
}

/* Activate a payment: 30 days from today, UNLESS the user's current period
   hasn't ended yet — then 30 days from that period's end, so a renewal
   never throws away days already paid for. This is the one place that rule
   lives; everything else just reads whatever period_start/period_end land
   here. */
export async function activateSubscription({ userId, amount, currency = 'PKR', paymentMethod = 'other', note, activatedBy }) {
  if (!userId) throw new SubscriptionError('userId is required.', 422)
  const amountNum = Number(amount)
  if (!Number.isFinite(amountNum) || amountNum < 0) {
    throw new SubscriptionError('amount must be a non-negative number.', 422)
  }
  const ALLOWED_METHODS = new Set(['bank_transfer', 'jazzcash', 'cash', 'other'])
  if (!ALLOWED_METHODS.has(paymentMethod)) {
    throw new SubscriptionError('Invalid payment method.', 422)
  }

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle()
  if (profileErr) throw new SubscriptionError(profileErr.message, 500)
  if (!profile) throw new SubscriptionError('User not found.', 404)

  const latest = await getLatestPayment(userId)
  const now = new Date()
  const currentExpiry = latest ? new Date(latest.period_end) : null
  const periodStart = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now
  const periodEnd = new Date(periodStart.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS)

  const { data, error } = await supabase
    .from('subscription_payments')
    .insert({
      user_id: userId,
      amount: amountNum,
      currency,
      payment_method: paymentMethod,
      note: note?.trim() || null,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      activated_by: activatedBy || null,
    })
    .select()
    .single()
  if (error) throw new SubscriptionError(error.message, 500)

  return data
}

export async function getSubscriptionHistory(userId, { page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, count, error } = await supabase
    .from('subscription_payments')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('period_end', { ascending: false })
    .range(from, to)
  if (error) throw new SubscriptionError(error.message, 500)

  return { payments: data || [], total: count || 0, page, pageSize }
}

const ALLOWED_SORTS = ['name', 'email', 'created_at', 'period_end']

/* Admin table: every user, joined with their latest (possibly nonexistent)
   subscription row. filter lets the UI narrow to active/expired/never. */
export async function listUsersWithSubscriptions({ page = 1, pageSize = 50, search = '', filter = 'all', sort = 'period_end', dir = 'desc' } = {}) {
  let query = supabase
    .from('profiles')
    .select('id, email, name, whatsapp_number, created_at', { count: 'exact' })

  if (search) {
    query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
  }

  // Sorting by subscription status happens client-side below once statuses
  // are merged in (Postgres can't order by a value from a separate view in
  // one PostgREST call); name/email/created_at sort at the DB, which also
  // keeps pagination correct for the common "just list everyone" case.
  const dbSort = sort === 'period_end' ? 'created_at' : sort
  query = query
    .order(dbSort, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: profiles, count, error } = await query
  if (error) throw new SubscriptionError(error.message, 500)

  if (!profiles || profiles.length === 0) {
    return { users: [], total: 0, page, pageSize }
  }

  const ids = profiles.map((p) => p.id)
  const { data: statusRows, error: statusErr } = await supabase
    .from('user_subscription_status')
    .select('*')
    .in('user_id', ids)
  if (statusErr) throw new SubscriptionError(statusErr.message, 500)

  const statusMap = {}
  for (const row of statusRows || []) statusMap[row.user_id] = row

  let users = profiles.map((p) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    whatsappNumber: p.whatsapp_number,
    createdAt: p.created_at,
    subscription: toStatus(statusMap[p.id] || null),
  }))

  if (filter === 'active') users = users.filter((u) => u.subscription.active)
  else if (filter === 'expired') users = users.filter((u) => !u.subscription.active && !u.subscription.neverSubscribed)
  else if (filter === 'never') users = users.filter((u) => u.subscription.neverSubscribed)

  if (sort === 'period_end') {
    users.sort((a, b) => {
      const av = a.subscription.periodEnd ? new Date(a.subscription.periodEnd).getTime() : -Infinity
      const bv = b.subscription.periodEnd ? new Date(b.subscription.periodEnd).getTime() : -Infinity
      return dir === 'desc' ? bv - av : av - bv
    })
  }

  // filter narrowed the page in memory, so `total` from the DB count (which
  // reflects only the search, not the status filter) would be wrong for
  // pagination — report what's actually being shown instead.
  const total = filter === 'all' ? (count || 0) : users.length

  return { users, total, page, pageSize }
}

export async function setWhatsappNumber(userId, whatsappNumber) {
  const { error } = await supabase
    .from('profiles')
    .update({ whatsapp_number: whatsappNumber?.trim() || null, updated_at: new Date().toISOString() })
    .eq('id', userId)
  if (error) throw new SubscriptionError(error.message, 500)
}
