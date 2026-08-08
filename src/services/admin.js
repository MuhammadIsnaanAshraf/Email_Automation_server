import { supabase } from '../lib/supabase.js'
import { env, clampGapSeconds } from '../config/env.js'
import { getSubscriptionStatus, hasUsedTrial, toStatus } from './subscriptions.js'
import { getUserSendSettings } from './campaigns.js'

export class AdminError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
    this.name = 'AdminError'
  }
}

const ALLOWED_USER_SORTS = ['email', 'name', 'created_at']

/* Same shape getUserSendSettings() returns, built from a user_settings row so
   the admin list can render pacing without one query per user. */
function sendSettingsFromRow(row) {
  const defaultGap = env.sending.defaultGapSeconds
  return {
    dailyLimit: row?.daily_send_limit > 0 ? row.daily_send_limit : 400,
    gapSeconds: row?.send_gap_seconds != null
      ? clampGapSeconds(row.send_gap_seconds, defaultGap)
      : defaultGap,
    gapIsCustom: row?.send_gap_seconds != null,
    platformDefaultGapSeconds: defaultGap,
  }
}

export async function listUsers({ page = 1, pageSize = 50, search = '', sort = 'created_at', dir = 'desc' }) {
  // One round trip via the admin_user_list view (see migration
  // 20240114000000_admin_user_list_view.sql): it LEFT JOINs profiles with
  // google_connections, user_settings and user_subscription_status, so the
  // page's data all comes back in a single PostgREST call. Only the auth
  // lookup for role/avatar stays separate — that's the GoTrue Admin API.
  let query = supabase
    .from('admin_user_list')
    .select('*', { count: 'exact' })

  if (search) {
    query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
  }

  const sortField = ALLOWED_USER_SORTS.includes(sort) ? sort : 'created_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const [rowsRes, authRes] = await Promise.all([
    query,
    supabase.auth.admin.listUsers({ perPage: 1000 }),
  ])
  const { data: rows, count, error } = rowsRes
  if (error) throw new AdminError(error.message, 500)

  if (!rows || rows.length === 0) {
    return { users: [], total: 0, page, pageSize }
  }

  const authMap = {}
  for (const u of authRes.data?.users || []) authMap[u.id] = u

  const users = rows.map((r) => {
    const au = authMap[r.id]
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      whatsappNumber: r.whatsapp_number,
      created_at: r.created_at,
      role: au?.app_metadata?.role || au?.user_metadata?.role || 'user',
      // Read-only here — deliberately no endpoint sets this. Only a manual
      // SQL UPDATE against auth.users does (20240116000000_account_status.sql).
      accountStatus: au?.app_metadata?.status || 'active',
      avatarUrl: au?.user_metadata?.avatar_url || au?.user_metadata?.picture || null,
      gmailConnected: r.gmail_status === 'connected',
      tokenExpiry: r.token_expiry || null,
      // period_end is null exactly when the user has never paid — hand toStatus
      // null in that case so it reports "never subscribed" instead of an epoch.
      subscription: r.period_end ? toStatus(r) : toStatus(null),
      // View columns match what sendSettingsFromRow reads (daily_send_limit,
      // send_gap_seconds), so the raw row works directly.
      sendSettings: sendSettingsFromRow(r),
      trialUsed: !!r.trial_used,
    }
  })

  return { users, total: count || 0, page, pageSize }
}

export async function getUser(id) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new AdminError(error.message, 500)
  }

  const { data: { user } } = await supabase.auth.admin.getUserById(id).catch(() => ({ data: { user: null } }))

  const [campaignsRes, sendsRes, subscription, sendSettings, trialUsed] = await Promise.all([
    supabase.from('campaigns').select('*', { count: 'exact', head: true }).eq('user_id', id),
    supabase.from('campaign_sends').select('*', { count: 'exact', head: true }).eq('user_id', id),
    getSubscriptionStatus(id),
    getUserSendSettings(id),
    hasUsedTrial(id),
  ])

  const { data: connection } = await supabase
    .from('google_connections')
    .select('status')
    .eq('user_id', id)
    .maybeSingle()

  return {
    ...profile,
    role: user?.app_metadata?.role || user?.user_metadata?.role || 'user',
    // Read-only — see the note in listUsers() above.
    accountStatus: user?.app_metadata?.status || 'active',
    avatarUrl: user?.user_metadata?.avatar_url || user?.user_metadata?.picture || null,
    gmailConnected: connection?.status === 'connected',
    campaignCount: campaignsRes.count || 0,
    totalSends: sendsRes.count || 0,
    subscription,
    sendSettings: { ...sendSettings, platformDefaultGapSeconds: env.sending.defaultGapSeconds },
    trialUsed,
  }
}

/* Set (or clear) this account's send-gap override. Passing null/'' clears it,
   putting the account back on the platform default — that's why "no override"
   is a distinct state rather than just writing the default value in. */
export async function updateUserSendSettings(id, { sendGapSeconds }) {
  const value = sendGapSeconds === null || sendGapSeconds === '' || sendGapSeconds === undefined
    ? null
    : clampGapSeconds(sendGapSeconds, null)

  if (sendGapSeconds != null && sendGapSeconds !== '' && value === null) {
    throw new AdminError('Send gap must be a number between 1 and 86400 seconds.', 422)
  }

  // upsert, not update: user_settings rows are created by a signup trigger,
  // but an account that predates it (or had its row removed) would otherwise
  // silently no-op here.
  const { error } = await supabase
    .from('user_settings')
    .upsert(
      { user_id: id, send_gap_seconds: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) throw new AdminError(error.message, 500)

  return getUserSendSettings(id)
}

export async function getSystemStats() {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const [totalUsers, totalCampaigns, totalTemplates, totalLists, sentRes, activeRes] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('templates').select('*', { count: 'exact', head: true }),
    supabase.from('recipient_lists').select('*', { count: 'exact', head: true }),
    supabase.from('campaign_sends').select('*', { count: 'exact', head: true }).not('sent_at', 'is', null),
    supabase.from('campaign_sends').select('user_id').gte('sent_at', today.toISOString()).not('sent_at', 'is', null),
  ])

  const activeUserIds = new Set((activeRes.data || []).map((s) => s.user_id))

  return {
    totalUsers: totalUsers.count || 0,
    totalCampaigns: totalCampaigns.count || 0,
    totalTemplates: totalTemplates.count || 0,
    totalLists: totalLists.count || 0,
    totalSends: sentRes.count || 0,
    activeUsers: activeUserIds.size,
  }
}

export async function getSystemLogs({ page = 1, pageSize = 50 }) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data: logs, count, error } = await supabase
    .from('system_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) throw new AdminError(error.message, 500)

  return { logs: logs || [], total: count || 0, page, pageSize }
}

export async function getTemplate(id) {
  const { data: template, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new AdminError(error.message, 500)
  }

  const [enriched] = await attachOwner([template])
  return enriched
}

const ALLOWED_TEMPLATE_SORTS = ['name', 'subject', 'updated_at', 'created_at']
const ALLOWED_LIST_SORTS = ['name', 'status', 'total_rows', 'valid_rows', 'created_at', 'updated_at']

async function attachOwner(rows) {
  if (!rows || rows.length === 0) return rows
  const ids = [...new Set(rows.map((r) => r.user_id))]
  const { data: owners } = await supabase
    .from('profiles')
    .select('id, name, email')
    .in('id', ids)

  const map = {}
  for (const o of owners || []) map[o.id] = o

  return rows.map((r) => ({
    ...r,
    owner: map[r.user_id] || { name: null, email: null },
  }))
}

export async function listTemplates({ page = 1, pageSize = 50, search = '', sort = 'updated_at', dir = 'desc' }) {
  let query = supabase
    .from('templates')
    .select('id, user_id, name, subject, variables, created_at, updated_at', { count: 'exact' })

  if (search) {
    query = query.or(`name.ilike.%${search}%,subject.ilike.%${search}%`)
  }

  const sortField = ALLOWED_TEMPLATE_SORTS.includes(sort) ? sort : 'updated_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: templates, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  return { templates: await attachOwner(templates || []), total: count || 0, page, pageSize }
}

export async function listAdminLists({ page = 1, pageSize = 50, search = '', sort = 'created_at', dir = 'desc' }) {
  let query = supabase
    .from('recipient_lists')
    .select('id, user_id, name, status, source_filename, total_rows, valid_rows, invalid_rows, created_at, updated_at', { count: 'exact' })

  if (search) {
    query = query.or(`name.ilike.%${search}%,source_filename.ilike.%${search}%`)
  }

  const sortField = ALLOWED_LIST_SORTS.includes(sort) ? sort : 'created_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: lists, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  return { lists: await attachOwner(lists || []), total: count || 0, page, pageSize }
}

const ALLOWED_CAMPAIGN_SORTS = ['name', 'status', 'total_recipients', 'sent_count', 'failed_count', 'created_at', 'updated_at']
const ALLOWED_SEND_SORTS = ['email', 'name', 'status', 'attempts', 'scheduled_at', 'sent_at']

export async function listAdminCampaigns({ page = 1, pageSize = 50, search = '', sort = 'created_at', dir = 'desc' } = {}) {
  let query = supabase
    .from('campaigns')
    .select('id, user_id, name, status, total_recipients, sent_count, failed_count, scheduled_at, created_at, updated_at', { count: 'exact' })

  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const sortField = ALLOWED_CAMPAIGN_SORTS.includes(sort) ? sort : 'created_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: campaigns, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  return { campaigns: await attachOwner(campaigns || []), total: count || 0, page, pageSize }
}

export async function getCampaignSends(campaignId, { page = 1, pageSize = 50, filter = 'all', search = '', sort = 'scheduled_at', dir = 'asc' } = {}) {
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id, user_id, name, status, total_recipients, sent_count, failed_count')
    .eq('id', campaignId)
    .single()

  if (campErr) {
    if (campErr.code === 'PGRST116') return null
    throw new AdminError(campErr.message, 500)
  }

  const [enriched] = await attachOwner([campaign])
  Object.assign(campaign, enriched)

  let query = supabase
    .from('campaign_sends')
    .select('id, email, name, company, status, attempts, scheduled_at, sent_at, error, created_at', { count: 'exact' })
    .eq('campaign_id', campaignId)

  if (filter !== 'all') {
    query = query.eq('status', filter)
  }
  if (search) {
    query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
  }

  const sortField = ALLOWED_SEND_SORTS.includes(sort) ? sort : 'scheduled_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: sends, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  return { campaign, sends: sends || [], total: count || 0, page, pageSize, filter, search, sort, dir }
}

const ALLOWED_ALL_SEND_SORTS = ['email', 'name', 'status', 'attempts', 'scheduled_at', 'sent_at', 'created_at']

export async function listAllSends({ page = 1, pageSize = 50, campaignName = '', userSearch = '', status = 'all', sort = 'scheduled_at', dir = 'desc' } = {}) {
  let campaignIds = null
  if (campaignName) {
    const { data: camps } = await supabase
      .from('campaigns')
      .select('id')
      .ilike('name', `%${campaignName}%`)
    campaignIds = camps?.map((c) => c.id) || []
    if (campaignIds.length === 0) {
      return { sends: [], total: 0, page, pageSize, campaignName, userSearch, status }
    }
  }

  let userIds = null
  if (userSearch) {
    const { data: users } = await supabase
      .from('profiles')
      .select('id')
      .or(`name.ilike.%${userSearch}%,email.ilike.%${userSearch}%`)
    userIds = users?.map((u) => u.id) || []
    if (userIds.length === 0) {
      return { sends: [], total: 0, page, pageSize, campaignName, userSearch, status }
    }
  }

  let query = supabase
    .from('campaign_sends')
    .select('id, campaign_id, user_id, email, name, company, status, attempts, scheduled_at, sent_at, error, created_at', { count: 'exact' })

  if (status !== 'all') query = query.eq('status', status)
  if (userIds) query = query.in('user_id', userIds)
  if (campaignIds) query = query.in('campaign_id', campaignIds)

  const sortField = ALLOWED_ALL_SEND_SORTS.includes(sort) ? sort : 'scheduled_at'
  query = query
    .order(sortField, { ascending: dir !== 'desc' })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: sends, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  if (!sends || sends.length === 0) {
    return { sends: [], total: 0, page, pageSize, campaignName, userSearch, status }
  }

  const campIds = [...new Set(sends.map((s) => s.campaign_id))]
  const sendUserIds = [...new Set(sends.map((s) => s.user_id))]
  const [campaignsRes, profilesRes] = await Promise.all([
    supabase.from('campaigns').select('id, name, user_id').in('id', campIds),
    supabase.from('profiles').select('id, name, email').in('id', sendUserIds),
  ])

  const campaignMap = {}
  for (const c of campaignsRes.data || []) campaignMap[c.id] = { name: c.name, user_id: c.user_id }
  const profileMap = {}
  for (const p of profilesRes.data || []) profileMap[p.id] = { name: p.name, email: p.email }

  const enriched = sends.map((s) => {
    const campaign = campaignMap[s.campaign_id] || {}
    const owner = profileMap[campaign.user_id] || profileMap[s.user_id] || {}
    return { ...s, campaignName: campaign.name || 'Unknown', owner: { name: owner.name, email: owner.email } }
  })

  return { sends: enriched, total: count || 0, page, pageSize, campaignName, userSearch, status }
}

const ALLOWED_RECIPIENT_SORTS = ['row_number', 'email', 'name', 'website', 'company', 'is_valid']

export async function getListRecipients(listId, { page = 1, pageSize = 50, filter = 'all', search = '', sort = 'row_number', dir = 'asc' } = {}) {
  const { data: list, error: listErr } = await supabase
    .from('recipient_lists')
    .select('id, user_id, name, status, total_rows, valid_rows, invalid_rows')
    .eq('id', listId)
    .single()

  if (listErr) {
    if (listErr.code === 'PGRST116') return null
    throw new AdminError(listErr.message, 500)
  }

  const [enriched] = await attachOwner([list])
  Object.assign(list, enriched)

  if (listErr) {
    if (listErr.code === 'PGRST116') return null
    throw new AdminError(listErr.message, 500)
  }

  let query = supabase
    .from('recipients')
    .select('*', { count: 'exact' })
    .eq('list_id', listId)

  if (filter === 'valid') query = query.eq('is_valid', true)
  else if (filter === 'invalid') query = query.eq('is_valid', false)

  const term = (search || '').slice(0, 200)
  if (term) {
    query = query.or(`email.ilike.%${term}%,name.ilike.%${term}%,company.ilike.%${term}%`)
  }

  const sortField = ALLOWED_RECIPIENT_SORTS.includes(sort) ? sort : 'row_number'
  query = query
    .order(sortField, { ascending: dir !== 'desc', nullsFirst: false })
    .order('row_number', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1)

  const { data: recipients, count, error } = await query
  if (error) throw new AdminError(error.message, 500)

  return { list, recipients: recipients || [], total: count || 0, page, pageSize, filter, search, sort, dir }
}
