import { hasActiveSubscription } from '../services/subscriptions.js'

/* Gate for paid features. Must run after requireAuth. Always re-checks the
   ledger (period_end > now()) on every request — there is no cached "is
   paid" flag anywhere to go stale. Admins bypass: the platform owner's own
   account isn't a customer of itself. */
export async function requireActiveSubscription(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()

    const active = await hasActiveSubscription(req.user.id)
    if (!active) {
      return res.status(402).json({ error: 'subscription_required', code: 'subscription_expired' })
    }
    next()
  } catch (err) {
    next(err)
  }
}
