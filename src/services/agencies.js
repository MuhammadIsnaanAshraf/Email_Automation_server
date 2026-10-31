import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { supabase } from '../lib/supabase.js'
import { makeOAuthClient } from '../lib/google.js'
import { env, GOOGLE_SCOPES, GMAIL_SEND_SCOPE } from '../config/env.js'
import { saveConnection, toPublicStatus } from './connections.js'

/* Agency accounts: one email/password login managing several Gmail accounts.

   Each attached account is a normal user in every respect — the agency just
   works as that user (see resolveAgencyMember, used by requireAuth). This file
   owns the parts that are new: signup, the attach/detach flow, and the admin
   review. agency_members is only ever written through link_agency_member()
   in the database, which enforces the sub-account limit under a row lock. */

export class AgencyError extends Error {
  constructor(message, status = 400, code = null) {
    super(message)
    this.name = 'AgencyError'
    this.status = status
    this.code = code
  }
}

const STATUSES = new Set(['pending', 'active', 'rejected', 'suspended'])
const STATE_TTL_MS = 15 * 60 * 1000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* ── Request-time lookup (used by requireAuth) ─────────────── */

/* Short cache so "is this agency allowed into this account?" is not three
   round trips on every API call. Anything that changes the answer (detach,
   admin status change) clears it, so staleness is bounded by this process's
   own writes plus CACHE_MS for writes made elsewhere. */
const CACHE_MS = 30_000
const memberCache = new Map()

export function invalidateAgencyCache(agencyId) {
  for (const key of memberCache.keys()) {
    if (key.startsWith(`${agencyId}:`)) memberCache.delete(key)
  }
}

/* Returns { agency, member } when `agencyId` may act as `memberId`, else
   { error } naming why not. `member` is the member's auth.users record. */
export async function resolveAgencyMember(agencyId, memberId) {
  const key = `${agencyId}:${memberId}`
  const hit = memberCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const [{ data: agency, error: aErr }, { data: link, error: lErr }] = await Promise.all([
    supabase.from('agencies').select('*').eq('user_id', agencyId).maybeSingle(),
    supabase
      .from('agency_members')
      .select('member_user_id')
      .eq('agency_id', agencyId)
      .eq('member_user_id', memberId)
      .maybeSingle(),
  ])
  if (aErr) throw aErr
  if (lErr) throw lErr

  let value
  if (!agency) value = { error: 'not_agency' }
  else if (agency.status !== 'active') value = { error: 'agency_not_active' }
  else if (!link) value = { error: 'account_not_in_agency' }
  else {
    const { data, error } = await supabase.auth.admin.getUserById(memberId)
    if (error || !data?.user) value = { error: 'account_not_in_agency' }
    else value = { agency, member: data.user }
  }

  memberCache.set(key, { value, expires: Date.now() + CACHE_MS })
  return value
}

/* ── Signup ────────────────────────────────────────────────── */

export async function signupAgency({ name, email, password }) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ')
  const cleanEmail = String(email || '').trim().toLowerCase()
  const pwd = String(password || '')

  if (cleanName.length < 2 || cleanName.length > 120) throw new AgencyError('Enter your agency name.')
  if (!EMAIL_RE.test(cleanEmail)) throw new AgencyError('Enter a valid email address.')
  if (pwd.length < 8 || pwd.length > 72) throw new AgencyError('Password must be 8–72 characters.')

  /* Created server-side so account_type lands in app_metadata, which only the
     service role can write — a browser signUp() could not mark itself an
     agency. The role/status triggers still run and merge in role 'user' and
     status 'active'. email_confirm skips the confirmation mail: admin approval
     is the gate for this kind of account. */
  const { data, error } = await supabase.auth.admin.createUser({
    email: cleanEmail,
    password: pwd,
    email_confirm: true,
    user_metadata: { full_name: cleanName },
    app_metadata: { account_type: 'agency' },
  })
  if (error) {
    if (/already|registered|exists/i.test(error.message)) {
      throw new AgencyError('An account with this email already exists. Sign in instead.', 409)
    }
    throw error
  }

  const userId = data.user.id
  const { error: insertErr } = await supabase.from('agencies').insert({
    user_id: userId,
    name: cleanName,
    status: 'pending',
    max_sub_accounts: env.agency.defaultMaxSubAccounts,
  })
  if (insertErr) {
    // Don't leave a login behind that has no agency row to explain it.
    await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw insertErr
  }

  return { id: userId, email: cleanEmail, name: cleanName, status: 'pending' }
}

/* ── The agency's own view ─────────────────────────────────── */

export async function getAgency(agencyId) {
  const { data, error } = await supabase.from('agencies').select('*').eq('user_id', agencyId).maybeSingle()
  if (error) throw error
  return data
}

export function toPublicAgency(row, memberCount = null) {
  if (!row) return null
  return {
    id: row.user_id,
    name: row.name,
    status: row.status,
    maxSubAccounts: row.max_sub_accounts,
    memberCount,
    reviewNote: row.status === 'rejected' || row.status === 'suspended' ? row.review_note : null,
    createdAt: row.created_at,
  }
}

async function countMembers(agencyId) {
  const { count, error } = await supabase
    .from('agency_members')
    .select('member_user_id', { count: 'exact', head: true })
    .eq('agency_id', agencyId)
  if (error) throw error
  return count || 0
}

export async function getAgencySummary(agencyId) {
  const row = await getAgency(agencyId)
  if (!row) return null
  return toPublicAgency(row, await countMembers(agencyId))
}

/* Every attached account with its Gmail health, newest first. */
export async function listMembers(agencyId) {
  const { data: links, error } = await supabase
    .from('agency_members')
    .select('member_user_id, added_at')
    .eq('agency_id', agencyId)
    .order('added_at', { ascending: false })
  if (error) throw error
  if (!links?.length) return []

  const ids = links.map((l) => l.member_user_id)
  const [{ data: profiles, error: pErr }, { data: conns, error: cErr }] = await Promise.all([
    supabase.from('profiles').select('id, email, name').in('id', ids),
    supabase.from('google_connections').select('*').in('user_id', ids),
  ])
  if (pErr) throw pErr
  if (cErr) throw cErr

  const profileById = new Map((profiles || []).map((p) => [p.id, p]))
  const connById = new Map((conns || []).map((c) => [c.user_id, c]))

  return links.map((l) => {
    const p = profileById.get(l.member_user_id) || {}
    const conn = toPublicStatus(connById.get(l.member_user_id) || null)
    return {
      id: l.member_user_id,
      email: p.email || null,
      name: p.name || null,
      addedAt: l.added_at,
      connection: {
        status: conn.status,
        canSendEmail: conn.canSendEmail,
        needsReconnect: conn.needsReconnect,
        needsReconnectForBounces: conn.needsReconnectForBounces,
      },
    }
  })
}

/* Detach an account. The account itself — its Gmail connection, lists and
   any scheduled campaigns — is untouched and keeps running; the agency just
   loses access to it. Whoever owns that Google account can still sign in to
   it directly. */
export async function removeMember(agencyId, memberId) {
  const { data, error } = await supabase
    .from('agency_members')
    .delete()
    .eq('agency_id', agencyId)
    .eq('member_user_id', memberId)
    .select('member_user_id')
  if (error) throw error
  invalidateAgencyCache(agencyId)
  if (!data?.length) throw new AgencyError('That account is not attached to your agency.', 404)
}

/* ── Attaching an account via Google ───────────────────────── */

/* The OAuth `state` is a signed, short-lived ticket naming the agency (and,
   for a reconnect, the exact account expected). It is what ties the Google
   callback — which arrives without any session — back to the agency that
   asked for it. */
function stateKey() {
  return createHmac('sha256', env.tokenEncryptionKey).update('agency-oauth-state').digest()
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function readState(state) {
  const [body, sig] = String(state || '').split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', stateKey()).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    return payload.exp > Date.now() ? payload : null
  } catch {
    return null
  }
}

/* Google consent URL for attaching a new account (memberId omitted) or
   reconnecting an attached one (memberId given). `returnTo` is where the
   browser lands afterwards: 'agency' (the accounts page) or 'dashboard'. */
export async function buildConnectUrl(agencyId, { memberId = null, returnTo = 'agency' } = {}) {
  const agency = await getAgency(agencyId)
  if (!agency) throw new AgencyError('Only agency accounts can attach Gmail accounts.', 403, 'not_agency')
  if (agency.status !== 'active') {
    throw new AgencyError('Your agency account is not active yet.', 403, 'agency_not_active')
  }
  if (!memberId && (await countMembers(agencyId)) >= agency.max_sub_accounts) {
    throw new AgencyError(
      `You have reached your limit of ${agency.max_sub_accounts} account${agency.max_sub_accounts === 1 ? '' : 's'}. Contact support to raise it.`,
      409,
      'limit_reached'
    )
  }

  let loginHint
  if (memberId) {
    const { data } = await supabase.from('profiles').select('email').eq('id', memberId).maybeSingle()
    loginHint = data?.email || undefined
  }

  const state = signState({
    a: agencyId,
    m: memberId,
    r: returnTo === 'dashboard' ? 'dashboard' : 'agency',
    n: randomBytes(8).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  })

  return makeOAuthClient().generateAuthUrl({
    access_type: 'offline',
    // consent: always return a refresh token. select_account: let the agency
    // pick which Google account to attach instead of reusing the last one.
    prompt: 'consent select_account',
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
    login_hint: loginHint,
  })
}

/* Find the user for a Google address, creating one if this inbox has never
   been seen. Returns { id, created }. */
async function findOrCreateUser({ email, name, picture }) {
  const lookup = async () => {
    const { data, error } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle()
    if (error) throw error
    return data?.id || null
  }

  const existing = await lookup()
  if (existing) return { id: existing, created: false }

  /* Same shape as a Google sign-up through Supabase, so if the owner of this
     inbox ever signs in to Zenviqo themselves, Supabase links their Google
     identity to this same user (matching verified email) and they see the
     same lists and campaigns. */
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name || null, avatar_url: picture || null },
  })
  if (error) {
    // Lost a race with a concurrent attach of the same inbox.
    const raced = await lookup()
    if (raced) return { id: raced, created: false }
    throw error
  }
  return { id: data.user.id, created: true }
}

const LINK_ERRORS = {
  not_agency: 'Only agency accounts can attach Gmail accounts.',
  agency_not_active: 'Your agency account is not active.',
  self: 'That is your agency login. Attach the Gmail accounts you send from instead.',
  member_is_agency: 'That Google account is an agency account and cannot be attached.',
  linked_elsewhere: 'That Gmail account is already managed by another agency.',
  limit_reached: 'You have reached your account limit. Contact support to raise it.',
}

/* Handle Google's redirect. Never throws for an expected failure; returns
   { returnTo, email?, error?, message? } for the route to turn into a
   redirect back to the app. */
export async function completeConnect({ code, state, error: oauthError }) {
  const ticket = readState(state)
  if (!ticket) return { returnTo: 'agency', error: 'expired', message: 'That link expired. Please try again.' }
  const returnTo = ticket.r

  if (oauthError) {
    return { returnTo, error: 'denied', message: 'Google access was not granted.' }
  }
  if (!code) return { returnTo, error: 'denied', message: 'Google access was not granted.' }

  const client = makeOAuthClient()
  let tokens
  let profile
  try {
    ;({ tokens } = await client.getToken(code))
    const ticketInfo = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.google.clientId })
    profile = ticketInfo.getPayload()
  } catch (err) {
    console.error('[agency] Google token exchange failed:', err?.response?.data || err)
    return { returnTo, error: 'google_failed', message: 'Google sign-in could not be completed. Please try again.' }
  }

  const email = String(profile?.email || '').toLowerCase()
  if (!email || profile.email_verified === false) {
    return { returnTo, error: 'unverified', message: 'That Google account has no verified email address.' }
  }

  const granted = String(tokens.scope || '').split(' ')
  if (!granted.includes(GMAIL_SEND_SCOPE)) {
    return {
      returnTo,
      error: 'missing_scope',
      email,
      message: 'Permission to send email was not granted. Tick every box on the Google screen and try again.',
    }
  }
  if (!tokens.refresh_token) {
    return { returnTo, error: 'google_failed', email, message: 'Google did not grant offline access. Please try again.' }
  }

  let user
  try {
    user = await findOrCreateUser({ email, name: profile.name, picture: profile.picture })
  } catch (err) {
    console.error('[agency] could not resolve user for', email, err)
    return { returnTo, error: 'internal', email, message: 'Something went wrong. Please try again.' }
  }

  // A reconnect must come back as the account it was started for, or the
  // agency would silently swap one inbox's tokens onto another.
  if (ticket.m && ticket.m !== user.id) {
    return {
      returnTo,
      error: 'wrong_account',
      email,
      message: `You signed in as ${email}, which is not the account you were reconnecting.`,
    }
  }

  const rollback = async () => {
    if (user.created) await supabase.auth.admin.deleteUser(user.id).catch(() => {})
  }

  if (!user.created) {
    const { data } = await supabase.auth.admin.getUserById(user.id)
    if (data?.user?.app_metadata?.role === 'admin') {
      return { returnTo, error: 'not_allowed', email, message: 'That Google account cannot be attached.' }
    }
  }

  const { data: result, error: linkErr } = await supabase.rpc('link_agency_member', {
    p_agency_id: ticket.a,
    p_member_id: user.id,
  })
  if (linkErr) {
    console.error('[agency] link_agency_member failed:', linkErr)
    await rollback()
    return { returnTo, error: 'internal', email, message: 'Something went wrong. Please try again.' }
  }
  if (result !== 'linked' && result !== 'already_linked') {
    await rollback()
    return { returnTo, error: result, email, message: LINK_ERRORS[result] || 'That account could not be attached.' }
  }

  try {
    await saveConnection(user.id, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
    })
  } catch (err) {
    console.error('[agency] saving Gmail connection failed:', err)
    return { returnTo, error: 'internal', email, message: 'The account was attached but its Gmail connection could not be saved. Reconnect it.' }
  }

  invalidateAgencyCache(ticket.a)
  return { returnTo, email, linked: result === 'linked', accountId: user.id }
}

/* ── Admin ─────────────────────────────────────────────────── */

export async function adminListAgencies({ status = 'all', search = '', page = 1, pageSize = 50 } = {}) {
  let query = supabase.from('agencies').select('*', { count: 'exact' })
  if (STATUSES.has(status)) query = query.eq('status', status)
  const term = String(search).replace(/[,()%_]/g, ' ').trim()
  if (term) query = query.ilike('name', `%${term}%`)

  const from = (page - 1) * pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)
  if (error) throw error

  const ids = (data || []).map((a) => a.user_id)
  const [profiles, links] = ids.length
    ? await Promise.all([
        supabase.from('profiles').select('id, email').in('id', ids),
        supabase.from('agency_members').select('agency_id').in('agency_id', ids),
      ])
    : [{ data: [] }, { data: [] }]
  if (profiles.error) throw profiles.error
  if (links.error) throw links.error

  const emailById = new Map((profiles.data || []).map((p) => [p.id, p.email]))
  const countById = new Map()
  for (const l of links.data || []) countById.set(l.agency_id, (countById.get(l.agency_id) || 0) + 1)

  const { count: pendingCount } = await supabase
    .from('agencies')
    .select('user_id', { count: 'exact', head: true })
    .eq('status', 'pending')

  return {
    agencies: (data || []).map((a) => ({
      ...toPublicAgency(a, countById.get(a.user_id) || 0),
      email: emailById.get(a.user_id) || null,
      reviewNote: a.review_note,
      reviewedAt: a.reviewed_at,
    })),
    total: count || 0,
    pendingCount: pendingCount || 0,
    page,
    pageSize,
  }
}

/* PATCH an agency: { status?, maxSubAccounts?, note? }. Suspending or
   rejecting takes effect on the agency's next request (cache cleared here).
   Attached accounts keep sending either way — this only controls whether the
   agency login can reach them. */
export async function adminUpdateAgency(agencyId, { status, maxSubAccounts, note }, adminId) {
  const patch = {}
  if (status !== undefined) {
    if (!STATUSES.has(status)) throw new AgencyError('Unknown status.')
    patch.status = status
    patch.reviewed_at = new Date().toISOString()
    patch.reviewed_by = adminId
  }
  if (maxSubAccounts !== undefined) {
    const n = Number(maxSubAccounts)
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new AgencyError('Limit must be a whole number from 0 to 1000.')
    patch.max_sub_accounts = n
  }
  if (note !== undefined) patch.review_note = note ? String(note).slice(0, 500) : null
  if (!Object.keys(patch).length) throw new AgencyError('Nothing to update.')

  const { data, error } = await supabase
    .from('agencies')
    .update(patch)
    .eq('user_id', agencyId)
    .select('*')
    .maybeSingle()
  if (error) throw error
  if (!data) throw new AgencyError('Agency not found.', 404)

  invalidateAgencyCache(agencyId)
  return toPublicAgency(data, await countMembers(agencyId))
}

export async function adminListAgencyMembers(agencyId) {
  if (!(await getAgency(agencyId))) throw new AgencyError('Agency not found.', 404)
  return listMembers(agencyId)
}

