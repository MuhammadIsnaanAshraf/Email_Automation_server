import { Router } from 'express'
import multer from 'multer'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { SheetParseError } from '../lib/parseSheet.js'
import { ISSUE_LABELS } from '../lib/validateRecipients.js'
import {
  ListError,
  createDraftFromData,
  createDraftFromSheet,
  getListsForUser,
  getListForUser,
  getRecipients,
  confirmList,
  renameList,
  deleteList,
} from '../services/lists.js'

const router = Router()

// Files are held in memory (never written to disk), parsed, then discarded.
const ACCEPTED = new Set([
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(csv|tsv|txt|xlsx|xls)$/i.test(file.originalname || '')
    if (ACCEPTED.has(file.mimetype) || okExt) return cb(null, true)
    cb(new ListError('Unsupported file type. Upload a CSV, TSV, or Excel file.', 415))
  },
})

router.use(requireAuth)

function decorate(recipient) {
  return {
    ...recipient,
    issues: [...(recipient.errors || []), ...(recipient.warnings || [])].map((code) => ({
      code,
      label: ISSUE_LABELS[code] || code,
      severity: (recipient.errors || []).includes(code) ? 'error' : 'warning',
    })),
  }
}

/* ── Upload parsed data (client-side parsed) ───────────────────
   POST /lists/upload   { name, recipients, headers, columnMap }
   Accepts JSON with already-parsed and validated rows from the frontend. */
router.post('/upload', async (req, res, next) => {
  try {
    console.log("req.body", req.body)
    const { name, recipients, headers, columnMap } = req.body

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      throw new ListError('No recipients provided.', 400)
    }
    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      throw new ListError('No headers provided.', 400)
    }
    if (!columnMap || columnMap.email == null) {
      throw new ListError('No email column mapping provided.', 400)
    }

    const listId = await createDraftFromData({
      userId: req.user.id,
      recipients,
      headers,
      columnMap,
      listName: name?.trim() || null,
    })

    const list = await getListForUser(req.user.id, listId)

    if (!list) {
      throw new ListError('List was created but could not be retrieved.', 500)
    }

    const sample = await getRecipients(listId, { filter: 'all', page: 1, pageSize: 50 })
    const invalid = await getRecipients(listId, { filter: 'invalid', page: 1, pageSize: 50 })

    res.status(201).json({
      list,
      preview: {
        columnMap: list.column_map,
        detectedHeaders: list.detected_headers,
        totals: {
          total: list.total_rows,
          valid: list.valid_rows,
          invalid: list.invalid_rows,
        },
        sample: sample.recipients.map(decorate),
        invalidRows: invalid.recipients.map(decorate),
      },
    })
  } catch (err) {
    if (err instanceof SheetParseError) return res.status(422).json({ error: err.message })
    if (err instanceof ListError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── List all of the user's lists ─────────────────────────────
   GET /lists */
router.get('/', async (req, res, next) => {
  try {
    const lists = await getListsForUser(req.user.id)
    res.json({ lists })
  } catch (err) {
    next(err)
  }
})

/* ── Get one list + its recipients (paginated / filterable) ───
   GET /lists/:id?filter=all|valid|invalid&page=1&pageSize=50 */
router.get('/:id', async (req, res, next) => {
  try {
    const list = await getListForUser(req.user.id, req.params.id)
    if (!list) return res.status(404).json({ error: 'list_not_found' })

    const filter = ['all', 'valid', 'invalid'].includes(req.query.filter) ? req.query.filter : 'all'
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50))

    const { recipients, total } = await getRecipients(list.id, { filter, page, pageSize })
    res.json({
      list,
      filter,
      page,
      pageSize,
      total,
      recipients: recipients.map(decorate),
    })
  } catch (err) {
    next(err)
  }
})

/* ── Confirm a draft → ready ──────────────────────────────────
   POST /lists/:id/confirm */
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const list = await confirmList(req.user.id, req.params.id)
    res.json({ list })
  } catch (err) {
    if (err instanceof ListError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/* ── Rename a list ────────────────────────────────────────────
   PATCH /lists/:id   { name } */
router.patch('/:id', async (req, res, next) => {
  try {
    const name = req.body?.name?.trim()
    if (!name) return res.status(400).json({ error: 'name_required' })
    const list = await renameList(req.user.id, req.params.id, name)
    if (!list) return res.status(404).json({ error: 'list_not_found' })
    res.json({ list })
  } catch (err) {
    next(err)
  }
})

/* ── Delete a list ────────────────────────────────────────────
   DELETE /lists/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    const list = await getListForUser(req.user.id, req.params.id)
    if (!list) return res.status(404).json({ error: 'list_not_found' })
    await deleteList(req.user.id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// Multer errors (e.g. file too large) → clean JSON.
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB).' : err.message
    return res.status(413).json({ error: msg })
  }
  if (err instanceof ListError) return res.status(err.status).json({ error: err.message })
  next(err)
})

export default router
