import { supabase } from '../lib/supabase.js'
import { parseSheet } from '../lib/parseSheet.js'
import {
  buildColumnMap,
  describeColumnMap,
  validateRows,
} from '../lib/validateRecipients.js'
import { BLOCKED_REFERENCE_STATUSES } from './templates.js'

/* Batch-insert size for the recipients table. Supabase/PostgREST handles large
   inserts, but we chunk to keep request payloads reasonable. */
const INSERT_CHUNK = 1000

export class ListError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ListError'
    this.status = status
  }
}

/* Common logic to persist a draft list + recipients after parsing/validation.
   Used by both createDraftFromSheet (server-side parse) and createDraftFromData
   (client-side parse). */
async function insertDraftList({ userId, listName, filename, recipients, headers, columnMap }) {
  const columnMapDescription = describeColumnMap(headers, columnMap)
  const validCount = recipients.filter((r) => r.is_valid).length
  const invalidCount = recipients.length - validCount

  const { data: list, error: listErr } = await supabase
    .from('recipient_lists')
    .insert({
      user_id: userId,
      name: listName || filename || 'Untitled list',
      source_filename: filename || null,
      status: 'draft',
      column_map: columnMapDescription,
      detected_headers: headers,
      total_rows: recipients.length,
      valid_rows: validCount,
      invalid_rows: invalidCount,
    })
    .select()
    .single()
  if (listErr) throw listErr

  try {
    for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
      const chunk = recipients.slice(i, i + INSERT_CHUNK).map((r) => ({
        list_id: list.id,
        user_id: userId,
        email: r.email,
        normalized_email: r.email ? r.email.toLowerCase().trim() : '',
        name: r.name || null,
        // Frontend now labels the mapped column "website"; the DB column stays
        // `company`, so map website → company on save.
        company: r.website || r.company || null,
        cc: r.cc || null,
        bcc: r.bcc || null,
        row_number: r.row_number,
        is_valid: r.is_valid,
        errors: r.errors || [],
        warnings: r.warnings || [],
        extra_data: r.extra || r.extra_data || {},
      }))
      const { error } = await supabase.from('recipients').insert(chunk)
      if (error) throw error
    }
  } catch (err) {
    await supabase.from('recipient_lists').delete().eq('id', list.id)
    throw err
  }

  return list.id
}

/* Accept already-parsed-and-validated data from the frontend
   (client-side XLSX parsing). The data must already be in recipient shape. */
export async function createDraftFromData({ userId, recipients, headers, columnMap, listName }) {
  const validCount = recipients.filter((r) => r.is_valid).length
  if (validCount < 1) {
    throw new ListError('This list has no valid recipients.', 422)
  }

  return insertDraftList({
    userId,
    listName,
    filename: listName || null,
    recipients,
    headers,
    columnMap,
  })
}

/* Parse + validate an uploaded sheet and persist it as a DRAFT list plus its
   recipient rows. Returns the created list id. Throws ListError with a clear
   message (e.g. no email column) so the route can 4xx instead of half-saving. */
export async function createDraftFromSheet({ userId, buffer, filename, mimetype, listName }) {
  const { headers, rows } = await parseSheet(buffer, filename, mimetype)
  console.log("🚀 ~ createDraftFromSheet ~ rows:", rows)

  const columnMap = buildColumnMap(headers)
  console.log("🚀 ~ createDraftFromSheet ~ columnMap:", columnMap)
  if (columnMap.email == null) {
    throw new ListError(
      'Could not find an email column. Make sure one column is labeled "email" (or similar). ' +
        `Detected columns: ${headers.join(', ')}`,
      422
    )
  }

  const recipients = validateRows(headers, rows, columnMap)
  console.log("🚀 ~ createDraftFromSheet ~ recipients:", recipients)
  const validCount = recipients.filter((r) => r.is_valid).length

  return insertDraftList({
    userId,
    listName,
    filename,
    recipients,
    headers,
    columnMap,
  })
}

/* All lists for a user, newest first (metadata only — no recipient rows). */
export async function getListsForUser(userId) {
  const { data, error } = await supabase
    .from('recipient_lists')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

const LIST_SORTABLE = new Set(['name', 'status', 'valid_rows', 'invalid_rows', 'created_at'])

export async function getListsForUserPaginated(userId, { page = 1, pageSize = 50, search = '', sort = 'created_at', dir = 'desc' } = {}) {
  const sortCol = LIST_SORTABLE.has(sort) ? sort : 'created_at'
  const sortDir = dir === 'desc' ? { ascending: false } : { ascending: true }

  let query = supabase
    .from('recipient_lists')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)

  if (search) {
    query = query.or(`name.ilike.%${search}%,source_filename.ilike.%${search}%`)
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order(sortCol, sortDir)
    .range(from, to)

  if (error) throw error
  return { lists: data || [], total: count || 0, page, pageSize, search, sort, dir }
}

/* A single list, scoped to its owner. Returns null if not found / not theirs. */
export async function getListForUser(userId, listId) {
  const { data, error } = await supabase
    .from('recipient_lists')
    .select('*')
    .eq('id', listId)
    .eq('user_id', userId)
    .single()
  if (error) return null
  return data
}

/* Columns the client is allowed to sort by, mapped to real DB columns. */
const SORTABLE_COLUMNS = {
  row_number: 'row_number',
  email: 'email',
  name: 'name',
  website: 'company',
  company: 'company',
  status: 'is_valid',
  is_valid: 'is_valid',
}

/* Escape a user search term for use inside a PostgREST `.or(...)` filter.
   Commas and parentheses are the operator delimiters, so they'd otherwise
   corrupt the expression; `%` and `_` are ilike wildcards. */
function sanitizeSearch(raw) {
  return String(raw)
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim()
}

/* Paginated + filterable + searchable + sortable recipients for a list.
   filter = 'all' | 'valid' | 'invalid'
   search = free text matched against email / name / company (ilike)
   sort   = one of SORTABLE_COLUMNS keys;  dir = 'asc' | 'desc'
   All of it runs in Postgres so large lists stay fast. */
export async function getRecipients(
  listId,
  { filter = 'all', page = 1, pageSize = 50, search = '', sort = 'row_number', dir = 'asc' } = {},
) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const sortColumn = SORTABLE_COLUMNS[sort] || 'row_number'
  const ascending = dir !== 'desc'

  let query = supabase
    .from('recipients')
    .select('*', { count: 'exact' })
    .eq('list_id', listId)
    .order(sortColumn, { ascending, nullsFirst: false })
    // Stable secondary + tiebreak ordering so pages never overlap or drop rows.
    .order('row_number', { ascending: true })
    .range(from, to)

  if (filter === 'valid') query = query.eq('is_valid', true)
  else if (filter === 'invalid') query = query.eq('is_valid', false)

  const term = sanitizeSearch(search)
  if (term) {
    query = query.or(`email.ilike.%${term}%,name.ilike.%${term}%,company.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) throw error
  // DB column is `company`; expose it as `website` so the UI/personalization
  // reads one name everywhere.
  const recipients = (data || []).map((r) => ({ ...r, website: r.website || r.company }))
  return { recipients, total: count ?? 0, page, pageSize }
}

/* Confirm a draft → 'ready'. Refuses if there isn't at least one valid row,
   so a user can't finalize a list that would email nobody. */
export async function confirmList(userId, listId) {
  const list = await getListForUser(userId, listId)
  if (!list) throw new ListError('List not found.', 404)
  if (list.status === 'ready') return list // idempotent
  if (list.valid_rows < 1) {
    throw new ListError('This list has no valid recipients to send to.', 422)
  }

  const { data, error } = await supabase
    .from('recipient_lists')
    .update({ status: 'ready', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', listId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function renameList(userId, listId, name) {
  const { data, error } = await supabase
    .from('recipient_lists')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', listId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) return null
  return data
}

export async function deleteList(userId, listId) {
  // recipients cascade-delete via the FK.
  const { error } = await supabase
    .from('recipient_lists')
    .delete()
    .eq('id', listId)
    .eq('user_id', userId)
  if (error) throw error
}

/* How the user's campaigns reference this list, grouped by status, plus whether
   any of them pin it (blocking deletion). Unlike templates, campaigns hold a
   LIVE reference to the list (list_id, on delete cascade), so deleting a list
   would silently take its campaigns and send history down with it. */
export async function getListUsage(userId, listId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('status')
    .eq('list_id', listId)
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

/* One representative recipient from a user's list, for template previews —
   prefers the first VALID row (that's what actually gets sent), falling back to
   the first row of any kind. Returns null if the list is empty / not theirs. */
export async function getSampleRecipient(userId, listId) {
  const list = await getListForUser(userId, listId)
  if (!list) return null

  const pick = async (validOnly) => {
    let q = supabase
      .from('recipients')
      .select('*')
      .eq('list_id', listId)
      .order('row_number', { ascending: true })
      .limit(1)
    if (validOnly) q = q.eq('is_valid', true)
    const { data } = await q
    return data?.[0] || null
  }

  return (await pick(true)) || (await pick(false))
}
