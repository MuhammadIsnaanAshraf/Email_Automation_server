import { supabase } from '../lib/supabase.js'
import { env } from '../config/env.js'
import { ApifyError, PoolExhaustedError, isConfigured, runToCompletion } from '../lib/apify.js'
import { cleanEmail } from '../lib/emails.js'

/* TikTok Shop creator finder: keywords + market in, affiliate creators with
   their sales (GMV) out, plus a contact email where one can be found.

   A search runs in two stages, in the background of this process:
     discover — creators selling in the market for each keyword, with revenue,
                units sold, growth and followers
     emails   — the creators discovery returned without an email are looked
                up by handle (bio + link-in-bio pages); that provider charges
                only for creators it finds an email for
   Both run on the shared provider key pool, so a key running dry mid-search
   hands over to the next one (see runToCompletion). The UI polls the search
   row; the user never sees provider names or provider errors. */

export class CreatorError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'CreatorError'
    this.status = status
  }
}

/* Markets the discovery provider covers. Revenue is reported in USD for all. */
export const MARKETS = ['GB', 'US', 'DE', 'FR', 'IT', 'ES', 'MX', 'BR', 'JP', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID']
const PERIODS = ['last30Day', 'last7Day', 'lastDay']

const MAX_KEYWORDS = 5
const MAX_KEYWORD_LENGTH = 60
const UPSERT_CHUNK = 500
const LOOKUP_CHUNK = 200

const SEARCH_COLUMNS =
  'id, keywords, country, period, per_keyword, min_revenue, min_followers, find_emails, status, stage, ' +
  'result_count, new_count, email_count, error, created_at, finished_at'

const UNAVAILABLE_MESSAGE = 'Creator search is temporarily unavailable. Please try again later.'

function cleanKeywords(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const term = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!term) continue
    if (term.length > MAX_KEYWORD_LENGTH) throw new CreatorError(`"${term.slice(0, 30)}…" is too long.`)
    if (seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    out.push(term)
  }
  if (out.length === 0) throw new CreatorError('Add at least one keyword, e.g. "beauty" or "supplements".')
  if (out.length > MAX_KEYWORDS) throw new CreatorError(`Use at most ${MAX_KEYWORDS} keywords per search.`)
  return out
}

function wholeNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return min
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new CreatorError(`${label} must be a whole number between ${min} and ${max}.`)
  return n
}

/* ── Mapping provider items ──────────────────────────────────── */

function text(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s ? s : null
}

function num(value) {
  const n = Number(value)
  return value == null || value === '' || !Number.isFinite(n) ? null : n
}

function handle(value) {
  const s = text(value)
  return s ? s.replace(/^@/, '').toLowerCase() : null
}

function instagramUrl(value) {
  const s = text(value)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  return `https://www.instagram.com/${s.replace(/^@/, '')}`
}

/* A discovery row. Contact fields only come back when discovery was asked
   for the shop's own contact data (CREATORS_DISCOVERY_WITH_CONTACTS). */
export function mapDiscovered(item) {
  if (item.type && item.type !== 'creator') return null // notices, errors
  const username = handle(item.username)
  if (!username) return null

  const { email } = cleanEmail(item.email)
  return {
    source_id: item.creatorId ? `c:${item.creatorId}` : `u:${username}`,
    username,
    nickname: text(item.nickname),
    profile_url: text(item.profileUrl) || `https://www.tiktok.com/@${username}`,
    country: text(item.country),
    matched_keyword: text(item.sourceInput),
    followers: num(item.followers),
    revenue: num(item.revenue),
    units_sold: num(item.unitsSold),
    revenue_growth_pct: num(item.revenueGrowthPercent),
    content_views: num(item.contentViews),
    avg_selling_price: num(item.avgSellingPrice),
    period: text(item.period),
    contacts: email || item.instagram || item.bio
      ? {
          email,
          email_source: email ? 'shop_profile' : null,
          instagram_url: instagramUrl(item.instagram),
          bio: text(item.bio),
        }
      : null,
  }
}

/* An email-lookup row (TikTok profile + contacts by handle). */
export function mapProfileContact(item) {
  const username = handle(item.username || item.sourceInput)
  if (!username) return null
  const { email } = cleanEmail(item.contactEmail || item.bioEmails?.[0] || item.linkEmails?.[0])
  return {
    username,
    email,
    email_source: email ? (item.contactEmailSource === 'bioLink' ? 'bio_link' : 'bio') : null,
    instagram_url: text(item.instagramUrl),
    avatar_url: text(item.avatarUrl),
    bio: text(item.bio),
  }
}

/* ── Storing ─────────────────────────────────────────────────── */

/* Upsert discovery rows. Rows that carry contacts are written separately from
   rows that don't, so a creator found again without contact data keeps the
   email an earlier search found (a missing column is left alone by the
   upsert; a null one would overwrite). Returns how many are new to this user. */
async function storeDiscovered(userId, searchId, items) {
  const bySource = new Map()
  for (const item of items) {
    const row = mapDiscovered(item)
    if (row) bySource.set(row.source_id, row)
  }
  const rows = [...bySource.values()]
  if (!rows.length) return 0

  const ids = rows.map((r) => r.source_id)
  const existing = new Set()
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('creators')
      .select('source_id')
      .eq('user_id', userId)
      .in('source_id', ids.slice(i, i + LOOKUP_CHUNK))
    if (error) throw error
    for (const r of data || []) existing.add(r.source_id)
  }

  const shape = ({ contacts, ...r }) => ({ ...r, ...(contacts || {}), user_id: userId, search_id: searchId })
  const withContacts = rows.filter((r) => r.contacts).map(shape)
  const without = rows.filter((r) => !r.contacts).map(shape)

  for (const group of [withContacts, without]) {
    for (let i = 0; i < group.length; i += UPSERT_CHUNK) {
      const { error } = await supabase
        .from('creators')
        .upsert(group.slice(i, i + UPSERT_CHUNK), { onConflict: 'user_id,source_id' })
      if (error) throw error
    }
  }
  return rows.filter((r) => !existing.has(r.source_id)).length
}

/* Write found emails (and profile extras) onto this search's creators. */
async function storeContacts(userId, searchId, items) {
  for (const item of items) {
    const c = mapProfileContact(item)
    if (!c || !c.email) continue
    const patch = { email: c.email, email_source: c.email_source }
    if (c.instagram_url) patch.instagram_url = c.instagram_url
    if (c.avatar_url) patch.avatar_url = c.avatar_url
    if (c.bio) patch.bio = c.bio
    const { error } = await supabase
      .from('creators')
      .update(patch)
      .eq('user_id', userId)
      .eq('search_id', searchId)
      .eq('username', c.username)
    if (error) throw error
  }
}

async function countSearch(searchId, { withEmail = false } = {}) {
  let q = supabase.from('creators').select('id', { count: 'exact', head: true }).eq('search_id', searchId)
  if (withEmail) q = q.not('email', 'is', null)
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

/* ── Running a search ────────────────────────────────────────── */

async function updateSearch(id, patch) {
  const { error } = await supabase.from('creator_searches').update(patch).eq('id', id)
  if (error) console.error('[creators] failed to update search', id, error)
}

function discoveryInput(search) {
  return {
    keywords: search.keywords,
    country: search.country,
    period: search.period,
    sortBy: 'revenue',
    maxResultsPerSource: search.per_keyword,
    minRevenue: search.min_revenue,
    minFollowers: search.min_followers,
    addAnalytics: env.creators.discoveryWithContacts,
  }
}

/* Handles on this search still without an email, or null when none are left. */
async function emailLookupInput(search) {
  const { data, error } = await supabase
    .from('creators')
    .select('username')
    .eq('search_id', search.id)
    .is('email', null)
    .limit(search.per_keyword * search.keywords.length)
  if (error) throw error
  if (!data?.length) return null
  return {
    handles: data.map((r) => r.username),
    // Charged only for creators with an email; the rest are checked free.
    onlyWithEmail: true,
    enrichBioLinks: true,
    maxResults: data.length,
  }
}

function resumeOf(search, stage) {
  return search.stage === stage && search.provider_run_id && search.key_fingerprint
    ? { fingerprint: search.key_fingerprint, runId: search.provider_run_id }
    : null
}

/* Drive a search through both stages. Safe to call for one already in flight
   (after a restart): it resumes the stage's run instead of starting another.
   Never throws — every outcome ends on the row. */
async function execute(search) {
  const persistRun = (r) =>
    updateSearch(search.id, { key_fingerprint: r.fingerprint, provider_run_id: r.runId })
  let newCount = search.new_count || 0

  // ── Stage 1: discover ──
  if (search.stage === 'discover') {
    try {
      const last = await runToCompletion(env.creators.discoveryActorId, async () => discoveryInput(search), {
        resume: resumeOf(search, 'discover'),
        onStart: persistRun,
        onItems: async (items) => {
          newCount += await storeDiscovered(search.user_id, search.id, items)
          await updateSearch(search.id, { result_count: await countSearch(search.id), new_count: newCount })
        },
        // Notice rows ride along with creators; leave headroom for them.
        maxItems: search.per_keyword * search.keywords.length + 50,
      })
      const found = await countSearch(search.id)
      if (found === 0) {
        if (last && last.status !== 'SUCCEEDED') {
          console.error(`[creators] search ${search.id}: discovery ended ${last.status}: ${last.statusMessage}`)
        }
        await updateSearch(search.id, {
          status: last?.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
          stage: 'done',
          error: last?.status === 'SUCCEEDED'
            ? 'No creators matched. Try broader keywords or lower the minimums.'
            : 'The search could not be completed. Please try again.',
          finished_at: new Date().toISOString(),
        })
        return
      }
    } catch (err) {
      console.error(`[creators] search ${search.id} discovery failed:`, err)
      const found = await countSearch(search.id).catch(() => 0)
      let message = 'The search could not be completed. Please try again.'
      if (err instanceof PoolExhaustedError) message = UNAVAILABLE_MESSAGE
      else if (err instanceof ApifyError && err.status === 400) message = 'These search settings were not accepted. Try different keywords.'
      if (found === 0) {
        await updateSearch(search.id, { status: 'failed', stage: 'done', error: message, finished_at: new Date().toISOString() })
        return
      }
      // Partial discovery still deserves its emails.
      await updateSearch(search.id, { error: 'Stopped early: fewer creators than requested.' })
    }

    if (!search.find_emails) {
      await finish(search, null)
      return
    }
    search = { ...search, stage: 'emails', provider_run_id: null, key_fingerprint: null }
    await updateSearch(search.id, { stage: 'emails', provider_run_id: null, key_fingerprint: null })
  }

  // ── Stage 2: emails ──
  // Best effort: the creators and their sales figures are the result; a failed
  // lookup only means fewer emails, never a failed search.
  let note = null
  if (search.stage === 'emails') {
    try {
      await runToCompletion(env.creators.emailActorId, () => emailLookupInput(search), {
        resume: resumeOf(search, 'emails'),
        onStart: persistRun,
        onItems: async (items) => {
          await storeContacts(search.user_id, search.id, items)
          await updateSearch(search.id, { email_count: await countSearch(search.id, { withEmail: true }) })
        },
      })
    } catch (err) {
      console.error(`[creators] search ${search.id} email lookup failed:`, err)
      note = 'Emails could not be looked up for every creator.'
    }
  }

  await finish(search, note)
}

async function finish(search, note) {
  const [resultCount, emailCount] = await Promise.all([
    countSearch(search.id).catch(() => null),
    countSearch(search.id, { withEmail: true }).catch(() => null),
  ])
  const patch = { status: 'succeeded', stage: 'done', finished_at: new Date().toISOString() }
  if (resultCount != null) patch.result_count = resultCount
  if (emailCount != null) patch.email_count = emailCount
  if (note) patch.error = note
  await updateSearch(search.id, patch)
}

export async function createSearch(userId, body = {}) {
  if (!isConfigured()) throw new CreatorError(UNAVAILABLE_MESSAGE, 503)

  const keywords = cleanKeywords(body.keywords)
  const country = String(body.country || 'GB').toUpperCase()
  if (!MARKETS.includes(country)) throw new CreatorError('That market is not supported.')
  const period = PERIODS.includes(body.period) ? body.period : 'last30Day'
  const perKeyword = wholeNumber(body.perKeyword, 'Creators per keyword', { min: 1, max: env.creators.maxPerKeyword })
  const minRevenue = wholeNumber(body.minRevenue, 'Minimum GMV', { max: 100_000_000 })
  const minFollowers = wholeNumber(body.minFollowers, 'Minimum followers', { max: 1_000_000_000 })

  const { data, error } = await supabase
    .from('creator_searches')
    .insert({
      user_id: userId,
      keywords,
      country,
      period,
      per_keyword: perKeyword,
      min_revenue: minRevenue,
      min_followers: minFollowers,
      find_emails: body.findEmails !== false,
      status: 'running',
      stage: 'discover',
    })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') {
      throw new CreatorError('A creator search is already running. Wait for it to finish before starting another.', 409)
    }
    throw error
  }

  execute(data) // background; outcome lands on the row
  const { key_fingerprint, provider_run_id, user_id, ...visible } = data
  return visible
}

/* Pick up searches this process was running when it last stopped. */
export async function resumeRunningSearches() {
  const { data, error } = await supabase.from('creator_searches').select('*').eq('status', 'running')
  if (error) {
    console.error('[creators] could not load running searches:', error)
    return
  }
  for (const search of data || []) {
    // Discovery that never got a run started has nothing to resume and has
    // spent nothing. Anything further along can carry on.
    if (search.stage === 'discover' && !search.provider_run_id) {
      await updateSearch(search.id, {
        status: 'failed',
        stage: 'done',
        error: 'The search was interrupted. Please run it again.',
        finished_at: new Date().toISOString(),
      })
    } else {
      console.log(`[creators] resuming search ${search.id} (${search.stage})`)
      execute(search)
    }
  }
}

/* ── Reads ───────────────────────────────────────────────────── */

export async function listSearches(userId, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('creator_searches')
    .select(SEARCH_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

export async function getSearch(userId, id) {
  const { data, error } = await supabase
    .from('creator_searches')
    .select(SEARCH_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new CreatorError('Search not found.', 404)
  return data
}

const SORTS = {
  revenue: 'revenue',
  followers: 'followers',
  growth: 'revenue_growth_pct',
  units: 'units_sold',
  recent: 'created_at',
}

const CREATOR_COLUMNS =
  'id, search_id, username, nickname, profile_url, avatar_url, country, matched_keyword, followers, revenue, ' +
  'units_sold, revenue_growth_pct, content_views, avg_selling_price, period, email, email_source, instagram_url, created_at'

export async function listCreators(
  userId,
  { page = 1, pageSize = 25, search = '', searchId = null, hasEmail = false, sort = 'revenue', dir = 'desc' } = {}
) {
  let query = supabase.from('creators').select(CREATOR_COLUMNS, { count: 'exact' }).eq('user_id', userId)
  if (searchId) query = query.eq('search_id', searchId)
  if (hasEmail) query = query.not('email', 'is', null)

  const term = String(search).replace(/[,()]/g, ' ').replace(/[%_]/g, '\\$&').trim()
  if (term) {
    query = query.or(['username', 'nickname', 'email', 'matched_keyword'].map((c) => `${c}.ilike.%${term}%`).join(','))
  }

  const from = (page - 1) * pageSize
  const { data, error, count } = await query
    .order(SORTS[sort] || 'revenue', { ascending: dir === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { creators: data || [], total: count || 0, page, pageSize }
}
