import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { requireActiveSubscription } from '../middleware/subscription.js'
import { requireActiveAccount } from '../middleware/accountStatus.js'
import {
  TemplateError,
  createTemplate,
  getTemplatesForUser,
  getTemplateForUser,
  updateTemplate,
  deleteTemplate,
  getTemplatesForUserPaginated,
  getTemplateUsage,
} from '../services/templates.js'
import { getSampleRecipient } from '../services/lists.js'
import { renderTemplate, buildContext, availableTokens } from '../lib/personalize.js'

const router = Router()
router.use(requireAuth, requireActiveAccount)

/* ── Live preview ─────────────────────────────────────────────
   POST /templates/preview   { subject, body, listId? }
   Renders the given content against a REAL row from one of the user's uploaded
   lists (first valid recipient), so the user previews with real data instead of
   sending blind. Falls back to a built-in sample if no list/row is available.
   Unresolved tokens are kept as literal {{token}} so gaps are visible. */
const FALLBACK_SAMPLE = {
  email: 'jordan.lee@example.com',
  name: 'Jordan Lee',
  company: 'Acme Inc',
  extra: { city: 'San Francisco' },
}

router.post('/preview', async (req, res, next) => {
  try {
    const { subject = '', body = '', listId = null } = req.body || {}

    let recipient = null
    let source = 'fallback'
    if (listId) {
      recipient = await getSampleRecipient(req.user.id, listId)
      if (recipient) source = 'list'
    }
    if (!recipient) recipient = FALLBACK_SAMPLE

    const rendered = renderTemplate({ subject, body }, recipient, { keepUnknown: true })

    res.json({
      source, // 'list' = real uploaded data, 'fallback' = built-in sample
      subject: rendered.subject,
      body: rendered.body,
      variables: rendered.variables,
      missing: rendered.missing,
      availableTokens: availableTokens(recipient),
      sample: {
        email: recipient.email,
        name: recipient.name,
        company: recipient.company,
        ...buildContext(recipient),
      },
    })
  } catch (err) {
    next(err)
  }
})

/* ── List the user's saved templates (paginated) ─────────────
   GET /templates?search=&sort=updated_at&dir=asc&page=1&pageSize=50 */
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50))
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : ''
    const sort = ['name', 'subject', 'updated_at', 'created_at'].includes(req.query.sort) ? req.query.sort : 'updated_at'
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc'

    const result = await getTemplatesForUserPaginated(req.user.id, { page, pageSize, search, sort, dir })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/* ── Create a template ────────────────────────────────────────
   POST /templates   { name, subject, body }
   Gated: authoring templates is a paid feature. */
router.post('/', requireActiveSubscription, async (req, res, next) => {
  try {
    const template = await createTemplate(req.user.id, req.body || {})
    res.status(201).json({ template })
  } catch (err) {
    if (err instanceof TemplateError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Template usage ───────────────────────────────────────────
   GET /templates/:id/usage
   How the user's campaigns reference this template (grouped by status) and
   whether any of them pin it — the delete flow uses this to decide whether
   deletion is allowed. */
router.get('/:id/usage', async (req, res, next) => {
  try {
    const template = await getTemplateForUser(req.user.id, req.params.id)
    if (!template) return res.status(404).json({ error: 'template_not_found' })
    const usage = await getTemplateUsage(req.user.id, req.params.id)
    res.json({ usage })
  } catch (err) {
    next(err)
  }
})

/* ── Get one template ─────────────────────────────────────────
   GET /templates/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const template = await getTemplateForUser(req.user.id, req.params.id)
    if (!template) return res.status(404).json({ error: 'template_not_found' })
    res.json({ template })
  } catch (err) {
    next(err)
  }
})

/* ── Update a template ────────────────────────────────────────
   PUT /templates/:id   { name?, subject?, body? } */
router.put('/:id', async (req, res, next) => {
  try {
    const template = await updateTemplate(req.user.id, req.params.id, req.body || {})
    res.json({ template })
  } catch (err) {
    if (err instanceof TemplateError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Delete a template ────────────────────────────────────────
   DELETE /templates/:id
   Refuses when scheduled/sending/completed campaigns still reference the
   template — deleting it would break their records. */
router.delete('/:id', async (req, res, next) => {
  try {
    const template = await getTemplateForUser(req.user.id, req.params.id)
    if (!template) return res.status(404).json({ error: 'template_not_found' })

    const usage = await getTemplateUsage(req.user.id, req.params.id)
    if (usage.blocked) {
      return res.status(409).json({
        error: 'template_in_use',
        message: 'This template is used by scheduled, sending, or completed campaigns and can’t be deleted.',
        usage,
      })
    }

    await deleteTemplate(req.user.id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
