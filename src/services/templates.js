import { randomUUID } from 'node:crypto'
import { supabase } from '../lib/supabase.js'
import { extractVariables } from '../lib/personalize.js'

export class TemplateError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'TemplateError'
    this.status = status
  }
}

const MAX_SUBJECT = 500
const MAX_BODY = 100_000

// Follow-up sequence limits — generous for a drip campaign, cheap enough to
// keep campaign_sends bounded (each follow-up multiplies the outbox by one
// more row per recipient).
export const MAX_FOLLOW_UPS = 5
export const MIN_FOLLOW_UP_DELAY_DAYS = 1
export const MAX_FOLLOW_UP_DELAY_DAYS = 60

/* Validate + normalize a template's follow-up sequence. Returns undefined
   when `list` is undefined (caller keeps whatever was already saved — same
   "only touch what was actually sent" convention as cleanFields). Each
   follow-up needs a subject or a body (same length caps as the main
   template) and a delayDays between the two bounds above — "wait N days
   after the previous email". */
function cleanFollowUps(list) {
  if (list === undefined) return undefined
  if (!Array.isArray(list)) throw new TemplateError('Follow-ups must be a list.', 422)
  if (list.length > MAX_FOLLOW_UPS) {
    throw new TemplateError(`You can add up to ${MAX_FOLLOW_UPS} follow-ups.`, 422)
  }

  return list.map((fu, i) => {
    const n = i + 1
    const subject = String(fu?.subject ?? '')
    const body = String(fu?.body ?? '')
    const delayDays = Math.round(Number(fu?.delayDays))

    if (!subject.trim() && !body.trim()) {
      throw new TemplateError(`Follow-up ${n} needs a subject or a body.`, 422)
    }
    if (subject.length > MAX_SUBJECT) throw new TemplateError(`Follow-up ${n} subject line is too long.`, 422)
    if (body.length > MAX_BODY) throw new TemplateError(`Follow-up ${n} message body is too long.`, 422)
    if (!Number.isFinite(delayDays) || delayDays < MIN_FOLLOW_UP_DELAY_DAYS || delayDays > MAX_FOLLOW_UP_DELAY_DAYS) {
      throw new TemplateError(
        `Follow-up ${n} needs a wait time between ${MIN_FOLLOW_UP_DELAY_DAYS} and ${MAX_FOLLOW_UP_DELAY_DAYS} days.`,
        422
      )
    }

    return {
      id: typeof fu?.id === 'string' && fu.id ? fu.id : randomUUID(),
      subject,
      body,
      delayDays,
      variables: extractVariables(subject, body),
    }
  })
}

/* Normalize + validate incoming template fields. Both subject and body are
   optional individually, but a template must have at least one of them so we
   never save an entirely empty draft. */
function cleanFields({ name, subject, body }, { requireName = true } = {}) {
  const out = {}
  if (name !== undefined) out.name = String(name).trim()
  if (subject !== undefined) out.subject = String(subject ?? '')
  if (body !== undefined) out.body = String(body ?? '')

  if (requireName && !out.name) throw new TemplateError('Template name is required.', 422)
  if (out.subject && out.subject.length > MAX_SUBJECT)
    throw new TemplateError('Subject line is too long.', 422)
  if (out.body && out.body.length > MAX_BODY)
    throw new TemplateError('Message body is too long.', 422)

  return out
}

export async function createTemplate(userId, fields) {
  const clean = cleanFields(fields, { requireName: true })
  const subject = clean.subject || ''
  const body = clean.body || ''
  if (!subject.trim() && !body.trim()) {
    throw new TemplateError('A template needs a subject or a body.', 422)
  }
  const followUps = cleanFollowUps(fields?.followUps) || []

  const { data, error } = await supabase
    .from('templates')
    .insert({
      user_id: userId,
      name: clean.name,
      subject,
      body,
      variables: extractVariables(subject, body),
      follow_ups: followUps,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getTemplatesForUser(userId) {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

const TEMPLATE_SORTABLE = new Set(['name', 'subject', 'updated_at', 'created_at'])

export async function getTemplatesForUserPaginated(userId, { page = 1, pageSize = 50, search = '', sort = 'updated_at', dir = 'asc' } = {}) {
  const sortCol = TEMPLATE_SORTABLE.has(sort) ? sort : 'updated_at'
  const sortDir = dir === 'desc' ? { ascending: false } : { ascending: true }

  let query = supabase
    .from('templates')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)

  if (search) {
    query = query.or(`name.ilike.%${search}%,subject.ilike.%${search}%`)
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order(sortCol, sortDir)
    .range(from, to)

  if (error) throw error
  return { templates: data || [], total: count || 0, page, pageSize, search, sort, dir }
}

export async function getTemplateForUser(userId, templateId) {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .eq('user_id', userId)
    .single()
  if (error) return null
  return data
}

/* Partial update. Recomputes `variables` from the resulting subject+body so the
   denormalized list always matches the content. */
export async function updateTemplate(userId, templateId, fields) {
  const existing = await getTemplateForUser(userId, templateId)
  if (!existing) throw new TemplateError('Template not found.', 404)

  const clean = cleanFields(fields, { requireName: false })
  const next = {
    name: clean.name ?? existing.name,
    subject: clean.subject ?? existing.subject,
    body: clean.body ?? existing.body,
    followUps: cleanFollowUps(fields?.followUps) ?? existing.follow_ups ?? [],
  }
  if (!next.name?.trim()) throw new TemplateError('Template name is required.', 422)
  if (!next.subject.trim() && !next.body.trim()) {
    throw new TemplateError('A template needs a subject or a body.', 422)
  }

  const { data, error } = await supabase
    .from('templates')
    .update({
      name: next.name,
      subject: next.subject,
      body: next.body,
      variables: extractVariables(next.subject, next.body),
      follow_ups: next.followUps,
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteTemplate(userId, templateId) {
  const { error } = await supabase
    .from('templates')
    .delete()
    .eq('id', templateId)
    .eq('user_id', userId)
  if (error) throw error
}

/* Campaign statuses that pin a template in place: as long as a campaign is
   scheduled, sending, or completed, deleting the template it was built from is
   blocked. Draft/paused/canceled campaigns keep their own snapshot of the
   subject+body, so they don't lock the template. */
export const BLOCKED_REFERENCE_STATUSES = ['scheduled', 'sending', 'completed']

/* How the user's campaigns reference this template, grouped by status, plus
   whether any of them pin it (blocking deletion). Used by the delete flow to
   explain — and by the backend DELETE to enforce. */
export async function getTemplateUsage(userId, templateId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('status')
    .eq('template_id', templateId)
    .eq('user_id', userId)
  if (error) throw error

  const byStatus = {}
  let blockedCount = 0
  for (const c of data || []) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1
    if (BLOCKED_REFERENCE_STATUSES.includes(c.status)) blockedCount++
  }
  return { byStatus, blockedCount, blocked: blockedCount > 0 }
}
