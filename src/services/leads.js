import { supabase } from '../lib/supabase.js'
import { env } from '../config/env.js'
import {
  ApifyError,
  PoolExhaustedError,
  isConfigured,
  startRun,
  waitForRun,
  fetchItems,
  markExhausted,
} from '../lib/apify.js'

/* Lead finder: job titles + countries in, people out.

   A search is a row in lead_searches that starts 'running' and ends
   'succeeded' or 'failed'. The provider run happens in the background of this
   process — the API returns as soon as the row exists, and the UI polls it.
   If a key runs out of credit (before the run starts or part-way through) the
   same search is restarted on the next key; the user only ever sees one search.

   The user never sees provider names or provider errors. `error` on a search
   is written for them; the real cause goes to the server log. */

export class LeadError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'LeadError'
    this.status = status
  }
}

const MAX_TERMS = 10
const MAX_TERM_LENGTH = 100
const UPSERT_CHUNK = 500
const LOOKUP_CHUNK = 200

// Columns a user may see on a search. Which key/run served it stays internal.
const SEARCH_COLUMNS =
  'id, titles, countries, requested_count, status, result_count, new_count, error, created_at, finished_at'

const UNAVAILABLE_MESSAGE = 'Lead search is temporarily unavailable. Please try again later.'

function cleanTerms(value, label) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const term = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!term) continue
    if (term.length > MAX_TERM_LENGTH) throw new LeadError(`"${term.slice(0, 30)}…" is too long.`)
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  if (out.length === 0) throw new LeadError(`Add at least one ${label}.`)
  if (out.length > MAX_TERMS) throw new LeadError(`Use at most ${MAX_TERMS} ${label}s per search.`)
  return out
}

/* ── Mapping provider items → lead rows ──────────────────────── */

/* Provider emails are sometimes built from a name with accents
   ("jorge.yáñez@…"). Almost no mail server accepts that, while the plain-ASCII
   form usually is the real mailbox, so transliterate — and count the result as
   a guess. Anything still not a plain address is dropped rather than stored. */
function cleanEmail(raw) {
  if (!raw) return { email: null, altered: false }
  const original = String(raw).trim().toLowerCase()
  const email = original.normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) {
    return { email: null, altered: false }
  }
  return { email, altered: email !== original }
}

function text(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s ? s : null
}

function int(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

function normalizeUrl(url) {
  const s = text(url)
  return s ? s.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '') : null
}

function sourceIdFor(item, email, linkedinUrl) {
  if (item.employee_id != null) return `e:${item.employee_id}`
  if (linkedinUrl) return `li:${linkedinUrl.toLowerCase()}`
  if (email) return `m:${email}`
  return null
}

export function mapItem(item) {
  const { email, altered } = cleanEmail(item.email)
  const linkedinUrl = normalizeUrl(item.linkedinUrl)
  const sourceId = sourceIdFor(item, email, linkedinUrl)
  if (!sourceId) return null

  const patternGuess = cleanEmail(item.emailPatternGuess).email
  const keywords = Array.isArray(item.organizationKeywords)
    ? item.organizationKeywords.map(text).filter(Boolean)
    : null

  return {
    source_id: sourceId,
    first_name: text(item.firstName),
    last_name: text(item.lastName),
    title: text(item.title),
    department: text(item.department),
    seniority: text(item.seniority),
    email,
    email_guessed: Boolean(email && (altered || patternGuess === email)),
    phone: text(item.phone),
    linkedin_url: linkedinUrl,
    city: text(item.city),
    state: text(item.state),
    country: text(item.country),
    company_name: text(item.organizationName),
    company_website: text(item.organizationWebsite),
    company_linkedin_url: normalizeUrl(item.organizationLinkedinUrl),
    company_industry: text(item.organizationIndustry),
    company_size: int(item.organizationSize),
    company_employee_range: text(item.organizationEmployeeRange),
    company_revenue: text(item.organizationRevenue),
    company_city: text(item.organizationCity),
    company_country: text(item.organizationCountry),
    company_description: text(item.organizationDescription),
    company_keywords: keywords && keywords.length ? keywords : null,
  }
}

/* Upsert items as this user's leads. A person found again is refreshed and
   re-pointed at this search rather than duplicated. Returns how many of the
   stored rows are people this user had never had before. */
async function storeLeads(userId, searchId, items) {
  const bySource = new Map()
  for (const item of items) {
    const row = mapItem(item)
    if (row) bySource.set(row.source_id, row)
  }
  const rows = [...bySource.values()]
  if (rows.length === 0) return { stored: 0, newCount: 0 }

  const ids = rows.map((r) => r.source_id)
  const existing = new Set()
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('leads')
      .select('source_id')
      .eq('user_id', userId)
      .in('source_id', ids.slice(i, i + LOOKUP_CHUNK))
    if (error) throw error
    for (const r of data || []) existing.add(r.source_id)
  }

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, user_id: userId, search_id: searchId }))
    const { error } = await supabase.from('leads').upsert(chunk, { onConflict: 'user_id,source_id' })
    if (error) throw error
  }

  return { stored: rows.length, newCount: rows.length - existing.size }
}

/* ── Running a search ────────────────────────────────────────── */

async function updateSearch(id, patch) {
  const { error } = await supabase.from('lead_searches').update(patch).eq('id', id)
  if (error) console.error('[leads] failed to update search', id, error)
}

async function countSearchLeads(searchId) {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('search_id', searchId)
  if (error) throw error
  return count || 0
}

function actorInput(search) {
  return {
    companyMode: false,
    personTitle: search.titles,
    personCountry: search.countries,
    totalResults: search.requested_count,
  }
}

/* Drive one search to completion. Safe to call for a search that already has
   a run in flight (after a restart) — it picks that run up instead of
   starting another. Never throws: every outcome ends on the row. */
async function execute(search) {
  const burned = new Set()
  let fp = search.key_fingerprint
  let runId = search.provider_run_id
  let attempts = search.attempts || 0
  let resultCount = search.result_count || 0
  let newCount = search.new_count || 0

  try {
    for (;;) {
      if (!runId) {
        const started = await startRun(actorInput(search), { skip: burned })
        fp = started.fingerprint
        runId = started.runId
        attempts += 1
        await updateSearch(search.id, { key_fingerprint: fp, provider_run_id: runId, attempts })
      }

      const run = await waitForRun(fp, runId)
      // Whatever the run produced is already paid for — keep it, whatever
      // happens next.
      const items = run.datasetId ? await fetchItems(fp, run.datasetId, { limit: search.requested_count }) : []
      const stored = await storeLeads(search.user_id, search.id, items)
      newCount += stored.newCount
      // Distinct people on this search. A retry on another key returns many of
      // the same people again, so summing per-run counts would overstate it.
      resultCount = await countSearchLeads(search.id)
      await updateSearch(search.id, { result_count: resultCount, new_count: newCount })

      if (run.outOfCredit && resultCount < search.requested_count) {
        // Key ran dry mid-run. Mark it and carry on with the next key; leads
        // the first run already found are deduped on the way in.
        await markExhausted(run.token, run.statusMessage)
        burned.add(fp)
        runId = null
        continue
      }

      if (run.status !== 'SUCCEEDED' && resultCount === 0) {
        console.error(`[leads] search ${search.id}: run ${runId} ended ${run.status}: ${run.statusMessage}`)
        await updateSearch(search.id, {
          status: 'failed',
          error: 'The search could not be completed. Please try again.',
          finished_at: new Date().toISOString(),
        })
        return
      }

      await updateSearch(search.id, { status: 'succeeded', error: null, finished_at: new Date().toISOString() })
      return
    }
  } catch (err) {
    console.error(`[leads] search ${search.id} failed:`, err)
    let message = 'The search could not be completed. Please try again.'
    if (err instanceof PoolExhaustedError) message = UNAVAILABLE_MESSAGE
    else if (err instanceof ApifyError && err.kind === 'fatal' && err.status === 400) {
      message = 'These search terms were not accepted. Try different job titles or countries.'
    }
    await updateSearch(search.id, {
      // Keep anything stored before the failure: a partial result is still a result.
      status: resultCount > 0 ? 'succeeded' : 'failed',
      error: resultCount > 0 ? `Stopped early: found ${resultCount} of ${search.requested_count}.` : message,
      finished_at: new Date().toISOString(),
    })
  }
}

export async function createSearch(userId, { titles, countries, count }) {
  if (!isConfigured()) throw new LeadError(UNAVAILABLE_MESSAGE, 503)

  const cleanTitles = cleanTerms(titles, 'job title')
  const cleanCountries = cleanTerms(countries, 'country')
  const requested = Number(count)
  if (!Number.isInteger(requested) || requested < 1 || requested > env.leads.maxPerSearch) {
    throw new LeadError(`Results must be a whole number between 1 and ${env.leads.maxPerSearch}.`)
  }

  const { data, error } = await supabase
    .from('lead_searches')
    .insert({
      user_id: userId,
      titles: cleanTitles,
      countries: cleanCountries,
      requested_count: requested,
      status: 'running',
    })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') {
      throw new LeadError('A search is already running. Wait for it to finish before starting another.', 409)
    }
    throw error
  }

  execute(data) // background; outcome lands on the row
  const { key_fingerprint, provider_run_id, attempts, user_id, ...visible } = data
  return visible
}

/* Pick up searches this process was running when it last stopped. */
export async function resumeRunningSearches() {
  const { data, error } = await supabase.from('lead_searches').select('*').eq('status', 'running')
  if (error) {
    console.error('[leads] could not load running searches:', error)
    return
  }
  for (const search of data || []) {
    if (search.provider_run_id && search.key_fingerprint) {
      console.log(`[leads] resuming search ${search.id}`)
      execute(search)
    } else {
      // Died before a run was started — nothing to resume, nothing spent.
      await updateSearch(search.id, {
        status: 'failed',
        error: 'The search was interrupted. Please run it again.',
        finished_at: new Date().toISOString(),
      })
    }
  }
}

/* ── Reads ───────────────────────────────────────────────────── */

export async function listSearches(userId, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('lead_searches')
    .select(SEARCH_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

export async function getSearch(userId, id) {
  const { data, error } = await supabase
    .from('lead_searches')
    .select(SEARCH_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new LeadError('Search not found.', 404)
  return data
}

/* Same escaping rules as lists.js / suppressions.js for PostgREST `.or()`. */
function sanitizeSearch(raw) {
  return String(raw)
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .trim()
}

const LEAD_LIST_COLUMNS =
  'id, search_id, first_name, last_name, title, seniority, email, email_guessed, linkedin_url, ' +
  'city, state, country, company_name, company_website, company_industry, company_employee_range, created_at'

export async function listLeads(userId, { page = 1, pageSize = 25, search = '', searchId = null, hasEmail = false } = {}) {
  let query = supabase
    .from('leads')
    .select(LEAD_LIST_COLUMNS, { count: 'exact' })
    .eq('user_id', userId)

  if (searchId) query = query.eq('search_id', searchId)
  if (hasEmail) query = query.not('email', 'is', null)

  const term = sanitizeSearch(search)
  if (term) {
    query = query.or(
      ['first_name', 'last_name', 'email', 'title', 'company_name']
        .map((c) => `${c}.ilike.%${term}%`)
        .join(',')
    )
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { leads: data || [], total: count || 0, page, pageSize }
}

export async function getLead(userId, id) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new LeadError('Lead not found.', 404)
  const { source_id, user_id, ...lead } = data
  return lead
}
