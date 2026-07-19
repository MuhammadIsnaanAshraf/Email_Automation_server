import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { saveConnection, getConnection, toPublicStatus } from '../services/connections.js'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { GOOGLE_SCOPES } from '../config/env.js'

const router = Router()

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
   Returns the Gmail connection status for the user. */
router.get('/connection/:userId', requireAuth, async (req, res) => {
  console.log("🚀 ~ [auth/connection] req.params.userId:", req.params.userId)
  try {
    const connection = await getConnection(req.params.userId)
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
    console.log("🚀 ~ Reconnecting Gmail for user:", req.user.id)
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${req.headers.origin || 'http://localhost:5173'}/auth/callback`,
        scopes: 'openid email profile https://www.googleapis.com/auth/gmail.send',
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
    console.error('[auth/reconnect] failed:', err)
    res.status(500).json({ error: 'reconnect_failed' })
  }
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