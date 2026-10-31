import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { saveConnection, getConnection, toPublicStatus } from '../services/connections.js'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { GOOGLE_SCOPES, env } from '../config/env.js'
import { buildConnectUrl, completeConnect, getAgencySummary, AgencyError } from '../services/agencies.js'

const router = Router()

/* ── Who am I ──────────────────────────────────────────────────
   GET /auth/me
   The single source of truth for the signed-in user's role AND account
   status — the frontend uses this to decide whether to show admin-only
   pages, and whether to show the "account inactive" screen instead of the
   portal. Both come from auth.users' app_metadata (requireAuth already
   resolved them onto req.user); `profiles` only supplies display fields
   here. Deliberately NOT gated by requireActiveAccount — an inactive user
   still needs this to succeed so the frontend can learn *why* it's blocked,
   rather than getting a bare 403 with nothing to render. */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, email, name')
      .eq('id', req.user.id)
      .single()
    if (error) throw error
    /* `agency` is set whenever the person signed in is an agency — whether
       or not they are currently inside one of its accounts. When they are,
       the profile fields above describe that account and `actingAs` is true. */
    const agencyId = req.agency?.id || (req.user.accountType === 'agency' ? req.user.id : null)
    const agency = agencyId ? await getAgencySummary(agencyId) : null
    res.json({
      ...profile,
      role: req.user.role,
      accountStatus: req.user.status,
      accountType: req.agency ? 'user' : req.user.accountType,
      agency: agency ? { ...agency, email: req.agency?.user.email || req.user.email } : null,
      actingAs: !!req.agency,
    })
  } catch (err) {
    console.error('[auth/me] failed:', err)
    res.status(500).json({ error: 'internal_error' })
  }
})

/* ── Save the Gmail connection after sign-in ─────────────────────
   POST /auth/callback
   Called from the frontend right after it exchanges the Supabase OAuth
   `code` for a session. The `code` itself can't be exchanged here: it's a
   PKCE code, so only the browser client that started the OAuth flow (and
   holds the matching code_verifier) can redeem it — and it's single-use, so
   the frontend must be the only one to redeem it. The frontend forwards us
   the resulting Google provider tokens (not Supabase's own session tokens). */
router.post('/callback', requireAuth, async (req, res) => {
  const { provider_token: providerToken, provider_refresh_token: providerRefreshToken } = req.body

  // No refresh token means Google didn't grant offline access this time
  // (e.g. a repeat sign-in without prompt=consent) — nothing new to store.
  if (!providerRefreshToken) {
    return res.json({ ok: true, saved: false })
  }

  // An agency login doesn't send from its own inbox; its Gmail accounts are
  // attached through /agency/accounts/connect instead. (Reachable only if an
  // agency signs in with Google using the same address as its login.)
  if (req.user.accountType === 'agency') {
    return res.json({ ok: true, saved: false })
  }

  try {
    await saveConnection(req.user.id, {
      access_token: providerToken,
      refresh_token: providerRefreshToken,
      // Supabase doesn't tell us the provider token's real expiry. Mark it as
      // already due for refresh so the first real send fetches an accurate
      // expiry/scope straight from Google's token endpoint (getValidAccessToken
      // -> refreshAccessToken), instead of depending on an extra Google API
      // call in the sign-in critical path.
      expiry_date: Date.now(),
      scopes: GOOGLE_SCOPES,
    })
    res.json({ ok: true, saved: true })
  } catch (err) {
    console.error('[auth/callback] failed to save Gmail connection:', err)
    res.status(500).json({ error: 'connection_save_failed' })
  }
})

/* ── Get connection status ─────────────────────────────────────
   GET /auth/connection/:userId
   Returns the Gmail connection status for the signed-in account. The path
   parameter is kept for compatibility but no longer trusted: the status is
   always for req.user — which, for an agency, is the account it is working
   in — so nobody can read another user's connection by changing the URL. */
router.get('/connection/:userId', requireAuth, async (req, res) => {
  try {
    const connection = await getConnection(req.user.id)
    console.log("🚀 ~ [auth/connection] connection:", connection)
    res.json(toPublicStatus(connection))
  } catch (err) {
    console.error('[auth/connection] failed:', err)
    res.status(500).json({ error: 'internal_error' })
  }
})

/* ── Reconnect Gmail ───────────────────────────────────────────
   POST /auth/reconnect
   Starts a new OAuth flow to refresh the Gmail grant. */
router.post('/reconnect', requireAuth, async (req, res) => {
  try {
    // Inside an agency, Supabase's browser OAuth would sign the agency out and
    // into the attached inbox. Reconnect through the agency's own Google flow,
    // pinned to this account, and come back to the dashboard.
    if (req.agency) {
      const url = await buildConnectUrl(req.agency.id, { memberId: req.user.id, returnTo: 'dashboard' })
      return res.json({ url })
    }

    console.log("🚀 ~ Reconnecting Gmail for user:", req.user.id)
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${req.headers.origin || 'http://localhost:5173'}/auth/callback`,
        scopes:
          'openid email profile ' +
          'https://www.googleapis.com/auth/gmail.send ' +
          // Reading the account's own delivery-failure notices is the only
          // way to know a message actually bounced rather than assume it.
          'https://www.googleapis.com/auth/gmail.readonly',
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    })
    console.log("🚀 ~ data:", data)
    
    if (error) throw error
    
    res.json({ url: data.url })
  } catch (err) {
    if (err instanceof AgencyError) return res.status(err.status).json({ error: err.message, code: err.code })
    console.error('[auth/reconnect] failed:', err)
    res.status(500).json({ error: 'reconnect_failed' })
  }
})

/* ── Google redirect for agency-attached accounts ──────────────
   GET /auth/google/callback?code&state
   Public: Google sends the browser here with no session. The signed `state`
   (see buildConnectUrl) is what identifies the agency. Always ends in a
   redirect back to the app with the outcome in the query string. */
router.get('/google/callback', async (req, res) => {
  let result
  try {
    result = await completeConnect({
      code: req.query.code,
      state: req.query.state,
      error: req.query.error,
    })
  } catch (err) {
    console.error('[auth/google/callback] failed:', err)
    result = { returnTo: 'agency', error: 'internal', message: 'Something went wrong. Please try again.' }
  }

  const path = result.returnTo === 'dashboard' && !result.error ? '/dashboard' : '/agency'
  const qs = new URLSearchParams()
  if (result.error) {
    qs.set('connect_error', result.error)
    qs.set('message', result.message || '')
  } else {
    qs.set(result.linked ? 'connected' : 'reconnected', result.email)
  }
  if (result.email) qs.set('email', result.email)
  res.redirect(`${env.frontendUrl}${path}?${qs.toString()}`)
})

/* ── Logout ────────────────────────────────────────────────────
   POST /auth/logout
   Signs out from Supabase Auth. */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    console.log("🚀 ~ Logging out user:", req.user.id)
    await supabase.auth.signOut()
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth/logout] failed:', err)
    res.status(500).json({ error: 'logout_failed' })
  }
})

export default router