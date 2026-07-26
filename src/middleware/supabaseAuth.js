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

  // Role lives in auth.users' raw_app_meta_data (exposed here as
  // app_metadata) — never in `profiles`. app_metadata can only be written by
  // a service-role client (see the promotion query in
  // 20240108000000_role_in_auth_metadata.sql), so a user can never grant
  // themselves admin by editing their own profile row. getUser() above is a
  // live lookup against auth.users, not a decode of the JWT's original
  // claims, so a promotion takes effect on this user's very next request.
  //
  // Fall back to user_metadata.role for cases where the role was set via
  // the Supabase Dashboard UI (which writes to raw_user_meta_data rather
  // than raw_app_meta_data). app_metadata takes precedence.
  req.user = user
  req.user.role = user.app_metadata?.role || user.user_metadata?.role || 'user'
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