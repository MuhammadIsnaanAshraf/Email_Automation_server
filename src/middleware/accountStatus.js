/* Gate for the entire user portal (lists/templates/campaigns) — not a paid
   feature check, an account-level kill switch. Must run after requireAuth
   (which resolves req.user.status from auth.users' app_metadata; see
   20240116000000_account_status.sql). There is no API path that sets an
   account 'inactive' — only a manual SQL UPDATE does that — so this only
   ever fires for accounts someone deliberately deactivated by hand.

   Admins bypass, same reasoning as requireActiveSubscription: the platform
   owner's own account was never meant to be disable-able through this
   mechanism. */
export function requireActiveAccount(req, res, next) {
  if (req.user?.role === 'admin') return next()
  if (req.user?.status === 'inactive') {
    return res.status(403).json({
      error: 'account_inactive',
      message: 'Your account has been deactivated. Contact support if you believe this is a mistake.',
    })
  }
  next()
}
