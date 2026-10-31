import { supabase } from '../lib/supabase.js'
import { resolveAgencyMember } from '../services/agencies.js'

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
  // Same source, same reasoning as role: only a service-role client (i.e. a
  // manual SQL UPDATE, never the app) can ever set this to 'inactive' — see
  // 20240116000000_account_status.sql. Defaults to 'active' so accounts
  // created before this migration, or missing the field for any reason,
  // aren't accidentally locked out.
  req.user.status = user.app_metadata?.status || 'active'
  // Only the service role can write app_metadata, so this can't be self-set.
  // The agencies table remains the authority on whether it's approved.
  req.user.accountType = user.app_metadata?.account_type === 'agency' ? 'agency' : 'user'
  req.accessToken = token

  /* ── Agency working inside one of its accounts ──────────────
     An agency login sends X-Account-Id to act as an attached account. If the
     link checks out, req.user BECOMES that account for the rest of the
     request — so every existing route, service and query (all scoped to
     req.user.id) works unchanged — and the agency is kept on req.agency for
     the few places that care (subscription, reconnect, /auth/me). The
     account is always treated as a plain user: an agency can never pick up
     admin rights through it. */
  const actAs = req.headers['x-account-id']
  if (actAs && actAs !== user.id) {
    if (req.user.accountType !== 'agency') {
      return res.status(403).json({ error: 'forbidden', code: 'not_agency' })
    }
    try {
      const resolved = await resolveAgencyMember(user.id, String(actAs))
      if (resolved.error) {
        return res.status(403).json({ error: 'forbidden', code: resolved.error })
      }
      req.agency = { id: user.id, row: resolved.agency, user: req.user }
      const member = resolved.member
      req.user = member
      req.user.role = 'user'
      req.user.status = member.app_metadata?.status || 'active'
      req.user.accountType = 'user'
    } catch (err) {
      return next(err)
    }
  }

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