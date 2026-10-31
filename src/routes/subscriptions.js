import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { SubscriptionError, getSubscriptionStatus, getSubscriptionHistory } from '../services/subscriptions.js'

const router = Router()
router.use(requireAuth)

/* ── My subscription ──────────────────────────────────────────
   GET /subscriptions/me
   Real-time status for the signed-in user: active/expired, days left or
   days since expiry, and their most recent payment's amount/method. */
router.get('/me', async (req, res, next) => {
  try {
    // Inside an agency, what counts is the agency's subscription (it covers
    // every account it manages) — unless the account pays for itself. Same
    // rule as requireActiveSubscription, so the UI and the API agree.
    const own = await getSubscriptionStatus(req.user.id)
    if (req.agency && !own.active) {
      const agency = await getSubscriptionStatus(req.agency.id)
      return res.json({ ...agency, coveredByAgency: true })
    }
    res.json(own)
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── My payment history ───────────────────────────────────────
   GET /subscriptions/me/history */
router.get('/me/history', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
    const result = await getSubscriptionHistory(req.user.id, { page, pageSize })
    res.json(result)
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export default router
