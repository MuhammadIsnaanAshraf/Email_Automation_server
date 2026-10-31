import { Router } from 'express'
import { AdminError, listUsers, getUser, updateUserSendSettings, getSystemStats, getSystemLogs, listTemplates, getTemplate, listAdminLists, getListRecipients, listAdminCampaigns, countUpcomingCampaigns, getCampaignSends, listAllSends } from '../services/admin.js'
import { SubscriptionError, listUsersWithSubscriptions, getSubscriptionHistory, activateSubscription, startTrial, setWhatsappNumber } from '../services/subscriptions.js'
import { requireAuth, requireAdmin } from '../middleware/supabaseAuth.js'
import { keyPoolStatus, resetKey } from '../lib/apify.js'
import { AgencyError, adminListAgencies, adminUpdateAgency, adminListAgencyMembers } from '../services/agencies.js'

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
    const status = ['all', 'upcoming', 'draft', 'scheduled', 'sending', 'paused', 'completed', 'canceled', 'failed']
      .includes(req.query.status) ? req.query.status : 'all'
    const sort = ['name', 'status', 'total_recipients', 'sent_count', 'created_at', 'scheduled_at'].includes(req.query.sort)
      ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    // The upcoming count is view-wide, not page-wide, so it stays meaningful
    // while paging or filtering.
    const [result, upcoming] = await Promise.all([
      listAdminCampaigns({ page, pageSize, search, status, sort, dir }),
      countUpcomingCampaigns(),
    ])
    res.json({ ...result, upcoming })
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

/* GET /admin/lead-keys — health of each lead-source API key, in the order
   they are tried. Fingerprints only; the tokens themselves never leave .env. */
router.get('/lead-keys', async (_req, res, next) => {
  try {
    res.json({ keys: await keyPoolStatus() })
  } catch (err) {
    next(err)
  }
})

/* POST /admin/lead-keys/:fingerprint/reset — put a key back in rotation early,
   e.g. after topping up its credit or fixing a mistyped token. */
router.post('/lead-keys/:fingerprint/reset', async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{16}$/.test(req.params.fingerprint)) return res.status(400).json({ error: 'invalid_fingerprint' })
    await resetKey(req.params.fingerprint)
    res.json({ keys: await keyPoolStatus() })
  } catch (err) {
    next(err)
  }
})

/* ── Agencies ─────────────────────────────────────────────────
   GET /admin/agencies?status=pending|active|rejected|suspended|all&search=&page= */
router.get('/agencies', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    res.json(await adminListAgencies({ status: req.query.status || 'all', search, page, pageSize }))
  } catch (err) {
    if (err instanceof AgencyError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* PATCH /admin/agencies/:id  { status?, maxSubAccounts?, note? }
   Approve ('active'), reject, suspend, or change the sub-account limit. */
router.patch('/agencies/:id', async (req, res, next) => {
  try {
    res.json(
      await adminUpdateAgency(
        req.params.id,
        { status: req.body?.status, maxSubAccounts: req.body?.maxSubAccounts, note: req.body?.note },
        req.user.id
      )
    )
  } catch (err) {
    if (err instanceof AgencyError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/agencies/:id/accounts', async (req, res, next) => {
  try {
    res.json({ accounts: await adminListAgencyMembers(req.params.id) })
  } catch (err) {
    if (err instanceof AgencyError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

export default router
