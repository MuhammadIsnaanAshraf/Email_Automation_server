import { Router } from 'express'
import { AdminError, listUsers, getUser, updateUserSendSettings, getSystemStats, getSystemLogs, listTemplates, getTemplate, listAdminLists, getListRecipients, listAdminCampaigns, getCampaignSends, listAllSends } from '../services/admin.js'
import { SubscriptionError, listUsersWithSubscriptions, getSubscriptionHistory, activateSubscription, startTrial, setWhatsappNumber } from '../services/subscriptions.js'
import { requireAuth, requireAdmin } from '../middleware/supabaseAuth.js'

const router = Router()

router.use(requireAuth, requireAdmin)

router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['email', 'name', 'created_at'].includes(req.query.sort) ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await listUsers({ page, pageSize, search, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await getUser(req.params.id)
    if (!user) return res.status(404).json({ error: 'user_not_found' })
    res.json(user)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* PATCH /admin/users/:id/send-settings   { sendGapSeconds }
   Per-account pacing override. Send `null` to clear it and fall back to the
   platform-wide SEND_DEFAULT_GAP_SECONDS. Applies to campaigns scheduled
   from here on; already-scheduled sends keep the times they were given. */
router.patch('/users/:id/send-settings', async (req, res, next) => {
  try {
    const settings = await updateUserSendSettings(req.params.id, {
      sendGapSeconds: req.body?.sendGapSeconds,
    })
    res.json({ sendSettings: settings })
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/stats', async (req, res, next) => {
  try {
    const stats = await getSystemStats()
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

router.get('/logs', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))

    const result = await getSystemLogs({ page, pageSize })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/templates', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['name', 'subject', 'updated_at', 'created_at'].includes(req.query.sort) ? req.query.sort : 'updated_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await listTemplates({ page, pageSize, search, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/templates/:id', async (req, res, next) => {
  try {
    const template = await getTemplate(req.params.id)
    if (!template) return res.status(404).json({ error: 'template_not_found' })
    res.json(template)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/lists', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['name', 'status', 'total_rows', 'valid_rows', 'created_at', 'updated_at'].includes(req.query.sort) ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await listAdminLists({ page, pageSize, search, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/sends', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const campaignName = typeof req.query.campaignName === 'string' ? req.query.campaignName.slice(0, 200) : ''
    const userSearch = typeof req.query.userSearch === 'string' ? req.query.userSearch.slice(0, 200) : ''
    const status = ['all', 'scheduled', 'sending', 'sent', 'failed', 'canceled'].includes(req.query.status) ? req.query.status : 'all'
    const sort = ['email', 'name', 'status', 'attempts', 'scheduled_at', 'sent_at', 'created_at'].includes(req.query.sort) ? req.query.sort : 'scheduled_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await listAllSends({ page, pageSize, campaignName, userSearch, status, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/campaigns', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['name', 'status', 'total_recipients', 'sent_count', 'created_at'].includes(req.query.sort) ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await listAdminCampaigns({ page, pageSize, search, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/campaigns/:id/sends', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const filter = ['all', 'scheduled', 'sending', 'sent', 'failed', 'canceled'].includes(req.query.filter) ? req.query.filter : 'all'
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['email', 'name', 'status', 'attempts', 'scheduled_at', 'sent_at'].includes(req.query.sort) ? req.query.sort : 'scheduled_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await getCampaignSends(req.params.id, { page, pageSize, filter, search, sort, dir })
    if (!result) return res.status(404).json({ error: 'campaign_not_found' })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/lists/:id/recipients', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const filter = ['all', 'valid', 'invalid'].includes(req.query.filter) ? req.query.filter : 'all'
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['row_number', 'email', 'name', 'website', 'company', 'is_valid'].includes(req.query.sort) ? req.query.sort : 'row_number'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await getListRecipients(req.params.id, { page, pageSize, filter, search, sort, dir })
    if (!result) return res.status(404).json({ error: 'list_not_found' })
    res.json(result)
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Subscriptions (Module 5: manual payment tracking) ────────
   GET /admin/subscriptions
   Every user + their current subscription status, for the "who's active,
   who's expired" screen. */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const filter = ['all', 'active', 'expired', 'never'].includes(req.query.filter) ? req.query.filter : 'all'
    const sort = ['name', 'email', 'created_at', 'period_end'].includes(req.query.sort) ? req.query.sort : 'period_end'
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc'

    const result = await listUsersWithSubscriptions({ page, pageSize, search, filter, sort, dir })
    res.json(result)
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* GET /admin/subscriptions/:userId/history — every payment ever activated
   for this user, most recent first. */
router.get('/subscriptions/:userId/history', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
    const result = await getSubscriptionHistory(req.params.userId, { page, pageSize })
    res.json(result)
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* POST /admin/subscriptions/:userId/activate
   { amount, currency?, paymentMethod?, note?, whatsappNumber? }
   Records the payment just received and applies the 30-day/extend rule.
   whatsappNumber (optional) is saved onto the profile in the same call so
   the admin can set/fix it right where they're already looking. */
router.post('/subscriptions/:userId/activate', async (req, res, next) => {
  try {
    const { amount, currency, paymentMethod, note, whatsappNumber } = req.body || {}

    if (typeof whatsappNumber === 'string') {
      await setWhatsappNumber(req.params.userId, whatsappNumber)
    }

    const payment = await activateSubscription({
      userId: req.params.userId,
      amount,
      currency,
      paymentMethod,
      note,
      activatedBy: req.user.id,
    })
    res.status(201).json({ payment })
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* POST /admin/subscriptions/:userId/start-trial   { days, note? }
   Grants a free trial — 30-day-rule's sibling for onboarding. Rejects with
   409 if this account has ever had a trial before, or currently has an
   active subscription (paid or trial) already. */
router.post('/subscriptions/:userId/start-trial', async (req, res, next) => {
  try {
    const { days, note } = req.body || {}
    console.log("🚀 ~ days:", days)
    const payment = await startTrial({
      userId: req.params.userId,
      days,
      note,
      activatedBy: req.user.id,
    })
    res.status(201).json({ payment })
  } catch (err) {
    if (err instanceof SubscriptionError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export default router
