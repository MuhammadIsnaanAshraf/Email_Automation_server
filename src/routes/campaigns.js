import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { requireActiveSubscription } from '../middleware/subscription.js'
import { hasActiveSubscription } from '../services/subscriptions.js'
import {
  CampaignError,
  createCampaign,
  getCampaignsForUser,
  getCampaignsForUserPaginated,
  getCampaignForUser,
  getCampaignRecipients,
  updateCampaignStatus,
  deleteCampaign,
  scheduleCampaign,
  getSendProgress,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getCampaignSends,
  getCampaignStats,
} from '../services/campaigns.js'

const router = Router()
router.use(requireAuth)

/* ── List the user's campaigns (paginated) ────────────────────
   GET /campaigns?filter=all&search=&sort=created_at&dir=desc&page=1&pageSize=50 */
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const filter = ['all', 'sending', 'paused', 'draft', 'scheduled', 'sent', 'failed', 'canceled'].includes(req.query.filter) ? req.query.filter : 'all'
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['name', 'status', 'total_recipients', 'sent_count', 'created_at'].includes(req.query.sort) ? req.query.sort : 'created_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await getCampaignsForUserPaginated(req.user.id, { page, pageSize, filter, search, sort, dir })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/* ── Create a campaign (template + list → campaign) ───────────
   POST /campaigns
   { name?, templateId?, subject?, body?, listId, scheduledAt?, frequency? }
   This is the handoff point to the sending module: it produces a self-contained
   campaign record (snapshotted content + recipient count). */
router.post('/', async (req, res, next) => {
  try {
    const campaign = await createCampaign(req.user.id, req.body || {})
    res.status(201).json({ campaign })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Aggregate campaign stats for the current user ────────────
   GET /campaigns/stats */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await getCampaignStats(req.user.id)
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

/* ── Get one campaign ─────────────────────────────────────────
   GET /campaigns/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const campaign = await getCampaignForUser(req.user.id, req.params.id)
    if (!campaign) return res.status(404).json({ error: 'campaign_not_found' })
    res.json({ campaign })
  } catch (err) {
    next(err)
  }
})

/* ── The recipients a campaign will send to (sender handoff) ──
   GET /campaigns/:id/recipients?page=1&pageSize=200 */
router.get('/:id/recipients', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 200))
    const { campaign, recipients, total } = await getCampaignRecipients(req.user.id, req.params.id, { page, pageSize })
    res.json({ campaignId: campaign.id, page, pageSize, total, recipients })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Change status (pause / resume / cancel; sender uses this too) ──
   PATCH /campaigns/:id/status   { status } */
router.patch('/:id/status', async (req, res, next) => {
  try {
    // This generic status route is also how the queue UI resumes a paused
    // campaign (status: 'sending') — the same real "start sending" action
    // POST /:id/schedule and /:id/resume gate below, so it needs the same
    // check, or a paused campaign would be an unguarded bypass around it.
    if (req.body?.status === 'sending' && req.user.role !== 'admin') {
      const active = await hasActiveSubscription(req.user.id)
      if (!active) return res.status(402).json({ error: 'subscription_required', code: 'subscription_expired' })
    }
    const campaign = await updateCampaignStatus(req.user.id, req.params.id, req.body?.status)
    res.json({ campaign })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Schedule a campaign (Module 4) ───────────────────────────
   POST /campaigns/:id/schedule   { startAt?, frequency?, dailyLimit? }
   Materializes a per-recipient send time for the whole list up front and hands
   the campaign off to the background sending engine. */
router.post('/:id/schedule', requireActiveSubscription, async (req, res, next) => {
  try {
    const result = await scheduleCampaign(req.user.id, req.params.id, req.body || {})
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Live send progress ───────────────────────────────────────
   GET /campaigns/:id/progress */
router.get('/:id/progress', async (req, res, next) => {
  try {
    const progress = await getSendProgress(req.user.id, req.params.id)
    res.json(progress)
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Paginated campaign sends (used by campaign detail page) ──
   GET /campaigns/:id/sends?filter=all&search=&sort=scheduled_at&dir=asc&page=1&pageSize=50 */
router.get('/:id/sends', async (req, res, next) => {
  try {
    const result = await getCampaignSends(req.user.id, req.params.id, {
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      pageSize: Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50)),
      filter: req.query.filter || 'all',
      search: req.query.search || '',
      sort: req.query.sort || 'scheduled_at',
      dir: req.query.dir || 'asc',
    })
    res.json(result)
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Pause / resume / cancel (convenience wrappers) ───────────*/
router.post('/:id/pause', async (req, res, next) => {
  try {
    res.json({ campaign: await pauseCampaign(req.user.id, req.params.id) })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.post('/:id/resume', requireActiveSubscription, async (req, res, next) => {
  try {
    res.json({ campaign: await resumeCampaign(req.user.id, req.params.id) })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.post('/:id/cancel', async (req, res, next) => {
  try {
    res.json({ campaign: await cancelCampaign(req.user.id, req.params.id) })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Delete a campaign ────────────────────────────────────────
   DELETE /campaigns/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const campaign = await getCampaignForUser(req.user.id, req.params.id)
    if (!campaign) return res.status(404).json({ error: 'campaign_not_found' })
    await deleteCampaign(req.user.id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
