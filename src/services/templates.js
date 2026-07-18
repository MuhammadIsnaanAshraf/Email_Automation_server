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

  const { data, error } = await supabase
    .from('templates')
    .insert({
      user_id: userId,
      name: clean.name,
      subject,
      body,
      variables: extractVariables(subject, body),
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
