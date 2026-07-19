import { supabase } from '../lib/supabase.js'
import { extractVariables } from '../lib/personalize.js'
import { computeSendTimes, frequencyToIntervalSeconds } from '../lib/scheduleSends.js'
import { getListForUser, getRecipients } from './lists.js'
import { getTemplateForUser } from './templates.js'

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

const ALLOWED_STATUS = new Set(['draft', 'scheduled', 'sending', 'sent', 'paused', 'failed', 'canceled'])

/* Status transition — used by the frontend (pause/schedule) and, later, the
   sending module (sending → sent/failed). Stamps started_at / completed_at. */
export async function updateCampaignStatus(userId, campaignId, status) {
  if (!ALLOWED_STATUS.has(status)) throw new CampaignError('Unknown campaign status.', 422)
  const existing = await getCampaignForUser(userId, campaignId)
  if (!existing) throw new CampaignError('Campaign not found.', 404)

  const patch = { status, updated_at: new Date().toISOString() }
  if (status === 'sending' && !existing.started_at) patch.started_at = new Date().toISOString()
  if (status === 'sent' || status === 'failed' || status === 'canceled') {
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

async function getUserDailyLimit(userId) {
  const { data } = await supabase.from('user_settings').select('daily_send_limit').eq('user_id', userId).single()
  return data?.daily_send_limit && data.daily_send_limit > 0 ? data.daily_send_limit : 400
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

   opts: { startAt?, frequency?, dailyLimit? } — all optional; frequency falls
   back to the campaign's stored frequency, dailyLimit to the user's account cap. */
export async function scheduleCampaign(userId, campaignId, opts = {}) {
  const campaign = await getCampaignForUser(userId, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)
  if (!campaign.list_id) throw new CampaignError('Campaign has no recipient list.', 422)
  if (['sending', 'sent'].includes(campaign.status)) {
    throw new CampaignError(`Campaign is already ${campaign.status}.`, 409)
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

  const frequency =
    opts.frequency && typeof opts.frequency === 'object' ? opts.frequency : campaign.frequency || {}
  const intervalSeconds = frequencyToIntervalSeconds(frequency)
  const dailyLimit = Number(opts.dailyLimit) > 0 ? Number(opts.dailyLimit) : await getUserDailyLimit(userId)
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
    extra: r.extra || {},
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
