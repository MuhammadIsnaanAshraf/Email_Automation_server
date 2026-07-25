import { supabase } from '../lib/supabase.js'

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', code: 'no_token' })
  }

  const token = authHeader.split(' ')[1]
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'unauthorized', code: 'invalid_token' })
  }

  // Role lives in `profiles`, not on the auth user itself — look it up here so
  // every route downstream (and requireAdmin) can trust req.user.role without
  // each one re-querying it.
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()

  req.user = user
  req.user.role = profile?.role || 'user'
  req.accessToken = token
  next()
}

// Gate for admin-only routes. Must run after requireAuth (which attaches
// req.user.role); a normal user gets a 403, not a redirect — this is an API,
// the frontend decides what to do with that.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', code: 'admin_required' })
  }
  next()
}

export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next()
  }

  const token = authHeader.split(' ')[1]
  const { data: { user } } = await supabase.auth.getUser(token)

  if (user) {
    req.user = user
    req.accessToken = token
  }
  next()
}