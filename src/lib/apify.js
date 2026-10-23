import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { supabase } from './supabase.js'

/* Apify client with a pool of API tokens.

   Tokens come from APIFY_TOKENS (comma-separated) and are tried in that order.
   When a token hits its monthly usage limit we record that against its
   fingerprint and move straight on to the next one, so the user's search just
   keeps going. The token itself is never written anywhere — only
   sha256(token)[:16] reaches the database (lead_source_keys).

   Nothing in this file produces a user-facing message. Callers get a
   PoolExhaustedError / ApifyError and decide what the user sees. */

const API = 'https://api.apify.com/v2'
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])

/* Apify's wording for "this account is out of credit" varies by error type
   (402 payment-required, 403 platform-feature-disabled, a run aborted mid-way
   with a status message…). Everything about usage, credit or limits means the
   same thing to us: this key is done for the month. */
const LIMIT_PATTERN = /usage|limit|credit|insufficient|exceed|quota|payment|balance/i

export class ApifyError extends Error {
  constructor(message, { kind = 'fatal', status = null } = {}) {
    super(message)
    this.name = 'ApifyError'
    // 'exhausted' | 'invalid' | 'retry' (try the next key) | 'fatal' (no key will help)
    this.kind = kind
    this.status = status
  }
}

export class PoolExhaustedError extends Error {
  constructor(message = 'No lead-source key has quota left') {
    super(message)
    this.name = 'PoolExhaustedError'
  }
}

export function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function tokenFor(fp) {
  return env.leads.apifyTokens.find((t) => fingerprint(t) === fp) || null
}

export function isConfigured() {
  return env.leads.apifyTokens.length > 0
}

/* Turn a non-2xx Apify response into an ApifyError of the right kind. */
function classify(status, body) {
  const type = body?.error?.type || ''
  const message = body?.error?.message || `HTTP ${status}`
  const text = `${type} ${message}`

  if (status === 401) return new ApifyError(message, { kind: 'invalid', status })
  if ((status === 402 || status === 403) && LIMIT_PATTERN.test(text)) {
    return new ApifyError(message, { kind: 'exhausted', status })
  }
  // Other 403s (e.g. a paid actor not rented on this account) are a problem
  // with this key, not with the search — another key may well work.
  if (status === 403 || status === 429 || status >= 500) {
    return new ApifyError(message, { kind: 'retry', status })
  }
  // 400/404: bad input or actor id. Every key would fail the same way.
  return new ApifyError(message, { kind: 'fatal', status })
}

async function call(token, path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new ApifyError(`network: ${err.message}`, { kind: 'retry' })
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw classify(res.status, json)
  return json
}

/* ── Key state ─────────────────────────────────────────────── */

/* Configured tokens that are usable right now, in APIFY_TOKENS order. An
   exhausted key whose billing cycle has rolled over counts as usable again. */
async function usableTokens() {
  const tokens = env.leads.apifyTokens
  const { data, error } = await supabase
    .from('lead_source_keys')
    .select('fingerprint, status, exhausted_until')
    .in('fingerprint', tokens.map(fingerprint))
  if (error) throw error

  const state = new Map((data || []).map((r) => [r.fingerprint, r]))
  const now = Date.now()
  return tokens.filter((t) => {
    const row = state.get(fingerprint(t))
    if (!row || row.status === 'active') return true
    if (row.status === 'exhausted') {
      return row.exhausted_until && new Date(row.exhausted_until).getTime() <= now
    }
    return false
  })
}

async function saveKeyState(fp, patch) {
  const { error } = await supabase
    .from('lead_source_keys')
    .upsert({ fingerprint: fp, ...patch }, { onConflict: 'fingerprint' })
  if (error) console.error('[apify] failed to save key state:', error)
}

/* When the key's usage cycle ends. Apify cycles run from the account's signup
   day, not the calendar month, so ask; fall back to the 1st of next month. */
async function cycleEnd(token) {
  try {
    const json = await call(token, '/users/me/limits')
    const endAt = json?.data?.monthlyUsageCycle?.endAt
    if (endAt) return new Date(endAt).toISOString()
  } catch {
    // An exhausted account can still usually read its limits; if not, guess.
  }
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString()
}

export async function markExhausted(token, reason) {
  const fp = fingerprint(token)
  const until = await cycleEnd(token)
  console.warn(`[apify] key ${fp} exhausted until ${until}: ${reason}`)
  await saveKeyState(fp, { status: 'exhausted', exhausted_until: until, last_error: String(reason).slice(0, 500) })
}

async function markInvalid(token, reason) {
  const fp = fingerprint(token)
  console.warn(`[apify] key ${fp} rejected: ${reason}`)
  await saveKeyState(fp, { status: 'invalid', last_error: String(reason).slice(0, 500) })
}

/* ── Runs ──────────────────────────────────────────────────── */

/* Start the actor on the first usable key, falling through the pool on any
   key-specific failure. `skip` lets a caller exclude keys it already burned
   during this search. Returns { fingerprint, runId, datasetId }. */
export async function startRun(input, { skip = new Set() } = {}) {
  if (!isConfigured()) throw new PoolExhaustedError('APIFY_TOKENS is not configured')

  const candidates = (await usableTokens()).filter((t) => !skip.has(fingerprint(t)))
  let lastError = null

  for (const token of candidates) {
    const fp = fingerprint(token)
    try {
      const json = await call(token, `/acts/${encodeURIComponent(env.leads.actorId)}/runs`, {
        method: 'POST',
        body: input,
      })
      await recordRunStarted(fp)
      return { fingerprint: fp, runId: json.data.id, datasetId: json.data.defaultDatasetId }
    } catch (err) {
      if (!(err instanceof ApifyError)) throw err
      lastError = err
      if (err.kind === 'exhausted') await markExhausted(token, err.message)
      else if (err.kind === 'invalid') await markInvalid(token, err.message)
      else if (err.kind === 'fatal') throw err
      else console.warn(`[apify] key ${fp} failed to start run, trying next: ${err.message}`)
    }
  }

  throw new PoolExhaustedError(lastError ? `All keys failed; last: ${lastError.message}` : undefined)
}

/* A successful start also proves the key is healthy, so clear any old verdict
   (e.g. an exhausted key whose cycle has rolled over). */
async function recordRunStarted(fp) {
  const { data } = await supabase.from('lead_source_keys').select('runs_count').eq('fingerprint', fp).maybeSingle()
  await saveKeyState(fp, {
    status: 'active',
    exhausted_until: null,
    last_error: null,
    last_used_at: new Date().toISOString(),
    runs_count: (data?.runs_count || 0) + 1,
  })
}

/* Block until the run reaches a terminal state. Apify holds each request open
   for up to 60s, so this is one cheap request a minute, not a busy loop. */
export async function waitForRun(fp, runId, { maxMinutes = 60 } = {}) {
  const token = tokenFor(fp)
  if (!token) throw new ApifyError(`token ${fp} is no longer configured`, { kind: 'fatal' })

  const deadline = Date.now() + maxMinutes * 60_000
  while (Date.now() < deadline) {
    let run
    try {
      run = (await call(token, `/actor-runs/${runId}?waitForFinish=60`)).data
    } catch (err) {
      if (err instanceof ApifyError && err.kind === 'retry') {
        await new Promise((r) => setTimeout(r, 5000))
        continue
      }
      throw err
    }
    if (TERMINAL.has(run.status)) {
      return {
        status: run.status,
        statusMessage: run.statusMessage || '',
        datasetId: run.defaultDatasetId,
        // A run that died because the account ran out of credit mid-way.
        outOfCredit: run.status !== 'SUCCEEDED' && LIMIT_PATTERN.test(run.statusMessage || ''),
        token,
      }
    }
  }
  throw new ApifyError(`run ${runId} still not finished after ${maxMinutes} minutes`, { kind: 'fatal' })
}

/* Every item in the run's dataset, paged. */
export async function fetchItems(fp, datasetId, { limit = 5000 } = {}) {
  const token = tokenFor(fp)
  if (!token) throw new ApifyError(`token ${fp} is no longer configured`, { kind: 'fatal' })

  const items = []
  const page = 1000
  while (items.length < limit) {
    const json = await fetch(
      `${API}/datasets/${datasetId}/items?clean=true&format=json&offset=${items.length}&limit=${Math.min(page, limit - items.length)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(async (res) => {
      const body = await res.json().catch(() => null)
      if (!res.ok) throw classify(res.status, body)
      return body
    })
    if (!Array.isArray(json) || json.length === 0) break
    items.push(...json)
    if (json.length < page) break
  }
  return items
}

/* Health of every configured key, for the admin view. Fingerprints only. */
export async function keyPoolStatus() {
  const fps = env.leads.apifyTokens.map(fingerprint)
  const { data, error } = await supabase.from('lead_source_keys').select('*').in('fingerprint', fps)
  if (error) throw error
  const byFp = new Map((data || []).map((r) => [r.fingerprint, r]))
  const now = Date.now()
  return fps.map((fp, i) => {
    const row = byFp.get(fp)
    const recovered = row?.status === 'exhausted' && row.exhausted_until && new Date(row.exhausted_until).getTime() <= now
    return {
      position: i + 1,
      fingerprint: fp,
      status: !row || recovered ? 'active' : row.status,
      exhaustedUntil: recovered ? null : row?.exhausted_until || null,
      lastError: row?.last_error || null,
      lastUsedAt: row?.last_used_at || null,
      runsCount: row?.runs_count || 0,
    }
  })
}

export async function resetKey(fp) {
  await saveKeyState(fp, { status: 'active', exhausted_until: null, last_error: null })
}
