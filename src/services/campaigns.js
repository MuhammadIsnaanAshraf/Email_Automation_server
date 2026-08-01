import { supabase } from '../lib/supabase.js'
import { env, clampGapSeconds } from '../config/env.js'
import { extractVariables } from '../lib/personalize.js'
import { computeSendTimes, frequencyToIntervalSeconds } from '../lib/scheduleSends.js'
import { getListForUser, getRecipients } from './lists.js'
import { getTemplateForUser } from './templates.js'
import { getValidAccessToken } from './connections.js'

export class CampaignError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'CampaignError'
    this.status = status
  }
}

/* Create a campaign = pair a template (or freshly-written subject/body) with an
   uploaded list. The template content is SNAPSHOTTED onto the campaign so later
   edits/deletes to the template don't mutate an already-created campaign.

   Input: { name?, templateId?, subject?, body?, listId, scheduledAt?, frequency? }
   - If templateId is given, its subject/body are used (unless subject/body are
     also explicitly provided, which override — e.g. the user tweaked a loaded
     template before scheduling).
   - The list must belong to the user and have at least one valid recipient. */
export async function createCampaign(userId, input = {}) {
  const { templateId = null, listId, scheduledAt = null, frequency = {} } = input
  console.log("🚀 ~ createCampaign ~ frequency:", frequency)
  console.log("🚀 ~ createCampaign ~ scheduledAt:", scheduledAt)
  console.log("🚀 ~ createCampaign ~ listId:", listId)
  console.log("🚀 ~ createCampaign ~ templateId:", templateId)

  if (!listId) throw new CampaignError('A recipient list is required.', 422)

  const list = await getListForUser(userId, listId)
  if (!list) throw new CampaignError('Recipient list not found.', 404)
  if (list.status === 'archived') throw new CampaignError('That list has been archived.', 422)
  if (!list.valid_rows || list.valid_rows < 1) {
    throw new CampaignError('That list has no valid recipients to send to.', 422)
  }

  // Resolve the content: explicit fields win, else fall back to the template.
  let subject = input.subject
  let body = input.body
  let template = null
  if (templateId) {
    template = await getTemplateForUser(userId, templateId)
    if (!template) throw new CampaignError('Template not found.', 404)
    if (subject === undefined) subject = template.subject
    if (body === undefined) body = template.body
  }
  subject = String(subject ?? '').trim()
  body = String(body ?? '')
  if (!subject) throw new CampaignError('A subject line is required.', 422)
  if (!body.trim()) throw new CampaignError('A message body is required.', 422)

  const name =
    String(input.name || '').trim() ||
    `${template?.name || 'Campaign'} → ${list.name}`

  const status = scheduledAt ? 'scheduled' : 'draft'

  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      user_id: userId,
      name,
      template_id: templateId,
      list_id: listId,
      subject,
      body,
      variables: extractVariables(subject, body),
      total_recipients: list.valid_rows,
      status,
      scheduled_at: scheduledAt,
      frequency: frequency && typeof frequency === 'object' ? frequency : {},
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/* All of a user's campaigns, newest first, enriched with the (current) template
   and list names for display. Uses a PostgREST embed via the FKs. */
export async function getCampaignsForUser(userId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, template:templates(id,name), list:recipient_lists(id,name,valid_rows)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

const CAMPAIGN_SORTABLE = new Set(['name', 'status', 'total_recipients', 'sent_count', 'created_at'])

export async function getCampaignsForUserPaginated(userId, { page = 1, pageSize = 50, filter = 'all', search = '', sort = 'created_at', dir = 'desc' } = {}) {
  const sortCol = CAMPAIGN_SORTABLE.has(sort) ? sort : 'created_at'
  const sortDir = dir === 'desc' ? { ascending: false } : { ascending: true }

  let query = supabase
    .from('campaigns')
    .select('*, template:templates(id,name), list:recipient_lists(id,name,valid_rows)', { count: 'exact' })
    .eq('user_id', userId)

  if (filter !== 'all') {
    query = query.eq('status', filter)
  }
  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order(sortCol, sortDir)
    .range(from, to)

  if (error) throw error
  return { campaigns: data || [], total: count || 0, page, pageSize, filter, search, sort, dir }
}

export async function getCampaignForUser(userId, campaignId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, template:templates(id,name), list:recipient_lists(id,name,valid_rows)')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .single()
  if (error) return null
  return data
}

/* The valid recipients a campaign will actually send to — the handoff the
   sending module consumes (campaign snapshot + these rows). */
export async function getCampaignRecipients(userId, campaignId, { page = 1, pageSize = 200 } = {}) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)
  if (!campaign.list_id) return { campaign, recipients: [], total: 0 }
  const { recipients, total } = await getRecipients(campaign.list_id, { filter: 'valid', page, pageSize })
  return { campaign, recipients, total }
}

const ALLOWED_STATUS = new Set(['draft', 'scheduled', 'sending', 'paused', 'completed', 'failed', 'canceled'])

/* Status transition — used by the frontend (pause/schedule) and, later, the
   sending module (sending → sent/failed). Stamps started_at / completed_at. */
export async function updateCampaignStatus(userId, campaignId, status) {
  if (!ALLOWED_STATUS.has(status)) throw new CampaignError('Unknown campaign status.', 422)
  const existing = await getCampaignForUser(userId, campaignId)
  if (!existing) throw new CampaignError('Campaign not found.', 404)

  const patch = { status, updated_at: new Date().toISOString() }
  if (status === 'sending' && !existing.started_at) patch.started_at = new Date().toISOString()
  if (status === 'completed' || status === 'failed' || status === 'canceled') {
    patch.completed_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update(patch)
    .eq('id', campaignId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteCampaign(userId, campaignId) {
  const { error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', campaignId)
    .eq('user_id', userId)
  if (error) throw error
}

// ─────────────────────────────────────────────────────────────
// Module 4: Scheduling — materialize per-recipient send times
// ─────────────────────────────────────────────────────────────

const SENDS_INSERT_CHUNK = 1000

/* Both pacing knobs for an account in one round-trip. `gapSeconds` falls back
   to the platform default when the account has no override on file (NULL),
   so callers always get a concrete, usable number. */
export async function getUserSendSettings(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('daily_send_limit, send_gap_seconds')
    .eq('user_id', userId)
    .maybeSingle()

  return {
    dailyLimit: data?.daily_send_limit > 0 ? data.daily_send_limit : 400,
    gapSeconds: data?.send_gap_seconds != null
      ? clampGapSeconds(data.send_gap_seconds, env.sending.defaultGapSeconds)
      : env.sending.defaultGapSeconds,
    // Whether the gap above came from this account's own override or the
    // platform default — the admin UI shows the difference.
    gapIsCustom: data?.send_gap_seconds != null,
    platformDefaultGapSeconds: env.sending.defaultGapSeconds,
  }
}

/* A frequency object only counts as "explicitly requested" if it actually
   carries a number. `{}` (which is what a campaign created without one
   stores) is an object too, so a plain truthiness check would treat it as a
   real request and silently pin the campaign to the library default instead
   of falling through to the account's configured gap. */
function pickExplicitFrequency(frequency) {
  if (!frequency || typeof frequency !== 'object') return null
  const hasEvery = Number(frequency.every) > 0
  const hasCount = Number(frequency.count) > 0
  return hasEvery || hasCount ? frequency : null
}

/* The pacing decision, isolated from all I/O so it can be reasoned about (and
   tested) on its own. Priority: an explicit per-schedule frequency, then the
   one the campaign was created with, then the account's configured gap.
   Returns both the interval to space sends by and the frequency object to
   persist — which always describes the gap ACTUALLY used, so a campaign
   record stays truthful even if the account's gap changes later. */
export function resolveSendInterval({ optsFrequency, campaignFrequency, userGapSeconds }) {
  const explicit = pickExplicitFrequency(optsFrequency) || pickExplicitFrequency(campaignFrequency)
  const intervalSeconds = explicit ? frequencyToIntervalSeconds(explicit) : userGapSeconds
  return {
    intervalSeconds,
    frequency: explicit || { count: 1, every: intervalSeconds, unit: 'seconds' },
  }
}

/* Page through every VALID recipient of a list (the ones that actually get
   emailed — invalid rows were flagged in Module 2 and are skipped here). */
async function loadAllValidRecipients(listId) {
  const pageSize = 1000
  const all = []
  for (let page = 1; ; page++) {
    const { recipients } = await getRecipients(listId, { filter: 'valid', page, pageSize })
    all.push(...recipients)
    if (recipients.length < pageSize) break
  }
  return all
}

/* Schedule a campaign: assign every valid recipient its own send time UP FRONT
   and write them to `campaign_sends`, then flip the campaign to 'scheduled'.
   This is the moment the whole timeline is decided; the background tick just
   sends whatever is due. Idempotent-guarded: refuses if sends already exist.

   opts: { startAt?, frequency?, dailyLimit? } — all optional. The gap between
   sends is resolved in priority order: an explicit `frequency` here → the one
   stored on the campaign at create time → the account's configured
   send_gap_seconds → SEND_DEFAULT_GAP_SECONDS. dailyLimit likewise falls back
   to the account's cap. */
export async function scheduleCampaign(userId, campaignId, opts = {}) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)
  if (!campaign.list_id) throw new CampaignError('Campaign has no recipient list.', 422)
  if (['sending', 'completed'].includes(campaign.status)) {
    throw new CampaignError(`Campaign is already ${campaign.status}.`, 409)
  }

  // Mint (or refresh) a Gmail access token now, up front, rather than letting
  // the send-tick cron discover a dead connection later. This also means the
  // token is already cached in google_connections by the time the first send
  // is due, so the tick can reuse it instead of paying for a refresh itself.
  const token = await getValidAccessToken(userId)
  if (token.error === 'network_error') {
    throw new CampaignError('Could not reach Google right now. Try scheduling again in a moment.', 503)
  }
  if (token.error) {
    throw new CampaignError('Gmail is not connected. Reconnect your account before scheduling.', 409)
  }

  // Don't double-schedule: a campaign's sends are created exactly once.
  const { count: existing } = await supabase
    .from('campaign_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (existing && existing > 0) {
    throw new CampaignError('Campaign is already scheduled.', 409)
  }

  const recipients = await loadAllValidRecipients(campaign.list_id)
  if (recipients.length === 0) {
    throw new CampaignError('That list has no valid recipients to send to.', 422)
  }

  // Gap resolution: explicit request → campaign's own → account's configured
  // gap → platform default (the last two already collapsed into gapSeconds).
  const settings = await getUserSendSettings(userId)
  const { intervalSeconds, frequency } = resolveSendInterval({
    optsFrequency: opts.frequency,
    campaignFrequency: campaign.frequency,
    userGapSeconds: settings.gapSeconds,
  })
  const dailyLimit = Number(opts.dailyLimit) > 0 ? Number(opts.dailyLimit) : settings.dailyLimit
  const startAt = opts.startAt ? new Date(opts.startAt) : new Date()
  if (Number.isNaN(startAt.getTime())) throw new CampaignError('Invalid start time.', 422)

  const times = computeSendTimes(recipients.length, { startAt, intervalSeconds, dailyLimit })

  const rows = recipients.map((r, i) => ({
    campaign_id: campaignId,
    user_id: userId,
    recipient_id: r.id,
    email: r.email,
    name: r.name,
    company: r.company,
    cc: r.cc || null,
    bcc: r.bcc || null,
    // Recipient rows store the extra columns as `extra_data`; the send snapshot
    // column is `extra`. Read the former (falling back to `extra`) so {{token}}
    // personalization from unmapped columns actually survives into the send.
    extra: r.extra_data || r.extra || {},
    scheduled_at: times[i].toISOString(),
    status: 'scheduled',
  }))

  // Insert the outbox in chunks; roll back all of it if any chunk fails so we
  // never leave a campaign half-scheduled.
  try {
    for (let i = 0; i < rows.length; i += SENDS_INSERT_CHUNK) {
      const { error } = await supabase
        .from('campaign_sends')
        .insert(rows.slice(i, i + SENDS_INSERT_CHUNK))
      if (error) throw error
    }
  } catch (err) {
    await supabase.from('campaign_sends').delete().eq('campaign_id', campaignId)
    throw err
  }

  const { data: updated, error: updErr } = await supabase
    .from('campaigns')
    .update({
      status: 'scheduled',
      scheduled_at: startAt.toISOString(),
      frequency,
      total_recipients: recipients.length,
      sent_count: 0,
      failed_count: 0,
      completed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('user_id', userId)
    .select()
    .single()
  if (updErr) throw updErr

  return {
    campaign: updated,
    totalScheduled: rows.length,
    intervalSeconds,
    dailyLimit,
    firstSendAt: times[0].toISOString(),
    lastSendAt: times[times.length - 1].toISOString(),
  }
}

/* Live progress for a campaign, computed from the outbox. */
export async function getSendProgress(userId, campaignId) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)

  const statuses = ['scheduled', 'sending', 'sent', 'failed', 'canceled']
  const counts = {}
  await Promise.all(
    statuses.map(async (status) => {
      const { count } = await supabase
        .from('campaign_sends')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', status)
      counts[status] = count || 0
    })
  )

  // Next upcoming send time, for a "resumes at …" hint in the UI.
  const { data: next } = await supabase
    .from('campaign_sends')
    .select('scheduled_at')
    .eq('campaign_id', campaignId)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const total = statuses.reduce((sum, s) => sum + counts[s], 0)
  return {
    campaign,
    total,
    counts,
    remaining: counts.scheduled + counts.sending,
    nextSendAt: next?.scheduled_at || null,
  }
}

/* Pause a running campaign — the claim query skips non-active campaigns, so
   already-scheduled sends simply stop being picked up until resumed. */
export async function pauseCampaign(userId, campaignId) {
  return updateCampaignStatus(userId, campaignId, 'paused')
}

export async function resumeCampaign(userId, campaignId) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)
  if (campaign.status !== 'paused') {
    throw new CampaignError('Only a paused campaign can be resumed.', 409)
  }
  return updateCampaignStatus(userId, campaignId, 'scheduled')
}

/* Paginated campaign sends with server-side search, filter, and sort.
   Used by the campaign detail page to show per-recipient send status. */
export async function getCampaignSends(userId, campaignId, { page = 1, pageSize = 50, filter = 'all', search = '', sort = 'scheduled_at', dir = 'asc' } = {}) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)

  const ALLOWED_SORTS = new Set(['email', 'name', 'status', 'scheduled_at', 'sent_at', 'attempts'])
  const sortCol = ALLOWED_SORTS.has(sort) ? sort : 'scheduled_at'
  const sortDir = dir === 'desc' ? { ascending: false } : { ascending: true }

  let query = supabase
    .from('campaign_sends')
    .select('*', { count: 'exact' })
    .eq('campaign_id', campaignId)

  if (filter !== 'all') {
    query = query.eq('status', filter)
  }
  if (search) {
    query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order(sortCol, sortDir)
    .range(from, to)

  if (error) throw error
  return { sends: data || [], total: count || 0, page, pageSize, filter, search, sort, dir }
}

/* Aggregate stats across all of a user's campaigns. */
export async function getCampaignStats(userId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('status, sent_count, failed_count, total_recipients')
    .eq('user_id', userId)

  if (error) throw error

  let totalSent = 0
  let totalFailed = 0
  let totalPending = 0
  const statusCounts = {}

  for (const c of data || []) {
    totalSent += c.sent_count || 0
    totalFailed += c.failed_count || 0
    if (['scheduled', 'sending', 'paused'].includes(c.status)) {
      totalPending += Math.max(0, (c.total_recipients || 0) - (c.sent_count || 0) - (c.failed_count || 0))
    }
    statusCounts[c.status] = (statusCounts[c.status] || 0) + 1
  }

  return {
    totalCampaigns: data?.length || 0,
    totalSent,
    totalFailed,
    totalPending,
    totalRecipients: data?.reduce((s, c) => s + (c.total_recipients || 0), 0) || 0,
    statusCounts,
  }
}

/* Cancel a campaign and drop any of its sends that haven't gone out yet.
   Already-sent emails obviously stay sent. */
export async function cancelCampaign(userId, campaignId) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)

  await supabase
    .from('campaign_sends')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .in('status', ['scheduled', 'sending'])

  return updateCampaignStatus(userId, campaignId, 'canceled')
}
