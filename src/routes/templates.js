import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import {
  TemplateError,
  createTemplate,
  getTemplatesForUser,
  getTemplateForUser,
  updateTemplate,
  deleteTemplate,
} from '../services/templates.js'
import { getSampleRecipient } from '../services/lists.js'
import { renderTemplate, buildContext, availableTokens } from '../lib/personalize.js'

const router = Router()
router.use(requireAuth)

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

/* ── List the user's saved templates ─────────────────────────
   GET /templates */
router.get('/', async (req, res, next) => {
  try {
    const templates = await getTemplatesForUser(req.user.id)
    res.json({ templates })
  } catch (err) {
    next(err)
  }
})

/* ── Create a template ────────────────────────────────────────
   POST /templates   { name, subject, body } */
router.post('/', async (req, res, next) => {
  try {
    const template = await createTemplate(req.user.id, req.body || {})
    res.status(201).json({ template })
  } catch (err) {
    if (err instanceof TemplateError) return res.status(err.status).json({ error: err.message })
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
   DELETE /templates/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const template = await getTemplateForUser(req.user.id, req.params.id)
    if (!template) return res.status(404).json({ error: 'template_not_found' })
    await deleteTemplate(req.user.id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
