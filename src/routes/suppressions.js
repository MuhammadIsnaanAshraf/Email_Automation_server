import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { requireActiveAccount } from '../middleware/accountStatus.js'
import {
  SuppressionError,
  getSuppressions,
  getSuppressionStats,
  getSuppressionDetail,
  suppressAddress,
  releaseAddress,
  getBounceScanState,
} from '../services/suppressions.js'

const router = Router()

router.use(requireAuth, requireActiveAccount)

function handle(res, next, err) {
  if (err instanceof SuppressionError) return res.status(err.status).json({ error: err.message })
  return next(err)
}

/* ── The do-not-send list ─────────────────────────────────────
   GET /suppressions?filter=suppressed|at_risk|all&search=&page=&pageSize= */
router.get('/', async (req, res, next) => {
  try {
    const result = await getSuppressions(req.user.id, {
      page: Number(req.query.page) || 1,
      pageSize: Math.min(Number(req.query.pageSize) || 50, 200),
      filter: req.query.filter || 'suppressed',
      search: req.query.search || '',
      sort: req.query.sort || 'last_failure_at',
      dir: req.query.dir || 'desc',
    })
    res.json(result)
  } catch (err) {
    handle(res, next, err)
  }
})

/* GET /suppressions/stats — headline counts plus scanner health, so the UI can
   tell "no bounces yet" apart from "we've never been able to look". */
router.get('/stats', async (req, res, next) => {
  try {
    const [stats, scan] = await Promise.all([
      getSuppressionStats(req.user.id),
      getBounceScanState(req.user.id),
    ])
    res.json({
      ...stats,
      scan: scan
        ? {
            lastRunAt: scan.last_run_at,
            lastScannedAt: scan.last_scanned_at,
            status: scan.last_status,
            error: scan.last_error,
            messagesScanned: scan.messages_scanned,
          }
        : null,
    })
  } catch (err) {
    handle(res, next, err)
  }
})

/* GET /suppressions/:email — the evidence behind one address. The address is
   URL-encoded by the client; Express decodes the param for us. */
router.get('/:email', async (req, res, next) => {
  try {
    res.json(await getSuppressionDetail(req.user.id, req.params.email))
  } catch (err) {
    handle(res, next, err)
  }
})

/* POST /suppressions  { email, reason? } — add one by hand. */
router.post('/', async (req, res, next) => {
  try {
    const result = await suppressAddress(req.user.id, req.body?.email, req.body?.reason)
    res.status(201).json(result)
  } catch (err) {
    handle(res, next, err)
  }
})

/* DELETE /suppressions/:email — lift a suppression and reset its counters. */
router.delete('/:email', async (req, res, next) => {
  try {
    res.json(await releaseAddress(req.user.id, req.params.email))
  } catch (err) {
    handle(res, next, err)
  }
})

export default router
