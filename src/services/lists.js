import { supabase } from '../lib/supabase.js'
import { parseSheet } from '../lib/parseSheet.js'
import {
  buildColumnMap,
  describeColumnMap,
  validateRows,
} from '../lib/validateRecipients.js'

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

/* Parse + validate an uploaded sheet and persist it as a DRAFT list plus its
   recipient rows. Returns the created list id. Throws ListError with a clear
   message (e.g. no email column) so the route can 4xx instead of half-saving. */
export async function createDraftFromSheet({ userId, buffer, filename, mimetype, listName }) {
  const { headers, rows } = await parseSheet(buffer, filename, mimetype)

  const columnMap = buildColumnMap(headers)
  if (columnMap.email == null) {
    throw new ListError(
      'Could not find an email column. Make sure one column is labeled "email" (or similar). ' +
        `Detected columns: ${headers.join(', ')}`,
      422
    )
  }

  const recipients = validateRows(headers, rows, columnMap)
  const validCount = recipients.filter((r) => r.is_valid).length

  // 1) Create the list row (draft).
  const { data: list, error: listErr } = await supabase
    .from('recipient_lists')
    .insert({
      user_id: userId,
      name: listName || filename || 'Untitled list',
      source_filename: filename || null,
      status: 'draft',
      column_map: describeColumnMap(headers, columnMap),
      detected_headers: headers,
      total_rows: recipients.length,
      valid_rows: validCount,
      invalid_rows: recipients.length - validCount,
    })
    .select()
    .single()
  if (listErr) throw listErr

  // 2) Insert recipients in chunks. If any chunk fails, roll back the list so we
  //    never leave a half-populated draft behind.
  try {
    for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
      const chunk = recipients.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, list_id: list.id }))
      const { error } = await supabase.from('recipients').insert(chunk)
      if (error) throw error
    }
  } catch (err) {
    await supabase.from('recipient_lists').delete().eq('id', list.id)
    throw err
  }

  return list.id
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

/* Paginated recipients for a list. `filter` = 'all' | 'valid' | 'invalid'. */
export async function getRecipients(listId, { filter = 'all', page = 1, pageSize = 50 } = {}) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let query = supabase
    .from('recipients')
    .select('*', { count: 'exact' })
    .eq('list_id', listId)
    .order('row_number', { ascending: true })
    .range(from, to)

  if (filter === 'valid') query = query.eq('is_valid', true)
  else if (filter === 'invalid') query = query.eq('is_valid', false)

  const { data, error, count } = await query
  if (error) throw error
  return { recipients: data, total: count ?? 0, page, pageSize }
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
