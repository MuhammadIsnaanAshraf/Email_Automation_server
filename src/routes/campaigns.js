import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import {
  CampaignError,
  createCampaign,
  getCampaignsForUser,
  getCampaignForUser,
  getCampaignRecipients,
  updateCampaignStatus,
  deleteCampaign,
  scheduleCampaign,
  getSendProgress,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
} from '../services/campaigns.js'

const router = Router()
router.use(requireAuth)

/* ── List the user's campaigns ────────────────────────────────
   GET /campaigns */
router.get('/', async (req, res, next) => {
  try {
    const campaigns = await getCampaignsForUser(req.user.id)
    res.json({ campaigns })
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
router.post('/:id/schedule', async (req, res, next) => {
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

/* ── Pause / resume / cancel (convenience wrappers) ───────────*/
router.post('/:id/pause', async (req, res, next) => {
  try {
    res.json({ campaign: await pauseCampaign(req.user.id, req.params.id) })
  } catch (err) {
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.post('/:id/resume', async (req, res, next) => {
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
