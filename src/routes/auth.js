import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { saveConnection, getConnection, toPublicStatus } from '../services/connections.js'
import { requireAuth } from '../middleware/supabaseAuth.js'

const router = Router()

/* ── Exchange Supabase auth code for session ────────────────────
   POST /auth/callback
   Called from the frontend after Supabase OAuth redirect. We exchange
   the code for a session and store the Gmail connection if present. */
router.post('/callback', async (req, res) => {
  const { code } = req.body
  
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    
    if (error || !data.session) {
      return res.status(400).json({ error: 'auth_failed', message: error?.message })
    }

    const { session, user } = data
    
    // Store Gmail connection if we have a refresh token
    if (session.provider_refresh_token) {
      await saveConnection(user.id, {
        access_token: session.access_token,
        refresh_token: session.provider_refresh_token,
        expiry_date: session.expires_at * 1000,
        scope: session.provider_token?.scope || '',
      })
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name,
        avatarUrl: user.user_metadata?.avatar_url || user.user_metadata?.picture,
      },
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    })
  } catch (err) {
    console.error('[auth/callback] failed:', err)
    res.status(500).json({ error: 'auth_failed' })
  }
})

/* ── Get connection status ─────────────────────────────────────
   GET /auth/connection/:userId
   Returns the Gmail connection status for the user. */
router.get('/connection/:userId', requireAuth, async (req, res) => {
  try {
    const connection = await getConnection(req.params.userId)
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
    await supabase.auth.signOut()
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth/logout] failed:', err)
    res.status(500).json({ error: 'logout_failed' })
  }
})

export default router