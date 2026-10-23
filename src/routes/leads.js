import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { requireActiveAccount } from '../middleware/accountStatus.js'
import { requireActiveSubscription } from '../middleware/subscription.js'
import { env } from '../config/env.js'
import {
  LeadError,
  createSearch,
  listSearches,
  getSearch,
  listLeads,
  getLead,
} from '../services/leads.js'

const router = Router()

router.use(requireAuth, requireActiveAccount)

function handle(res, next, err) {
  if (err instanceof LeadError) return res.status(err.status).json({ error: err.message })
  return next(err)
}

/* GET /leads/searches — recent searches plus the per-search result cap, so the
   form can show the real limit. */
router.get('/searches', async (req, res, next) => {
  try {
    res.json({ searches: await listSearches(req.user.id), maxPerSearch: env.leads.maxPerSearch })
  } catch (err) {
    handle(res, next, err)
  }
})

/* POST /leads/searches  { titles: string[], countries: string[], count }
   Returns 202 with the 'running' search; poll GET /leads/searches/:id. Each
   search spends provider credit, so it sits behind the subscription gate. */
router.post('/searches', requireActiveSubscription, async (req, res, next) => {
  try {
    const search = await createSearch(req.user.id, {
      titles: req.body?.titles,
      countries: req.body?.countries,
      count: req.body?.count,
    })
    res.status(202).json(search)
  } catch (err) {
    handle(res, next, err)
  }
})

router.get('/searches/:id', async (req, res, next) => {
  try {
    res.json(await getSearch(req.user.id, req.params.id))
  } catch (err) {
    handle(res, next, err)
  }
})

/* GET /leads?search=&searchId=&hasEmail=1&page=&pageSize= */
router.get('/', async (req, res, next) => {
  try {
    res.json(
      await listLeads(req.user.id, {
        page: Math.max(1, Number(req.query.page) || 1),
        pageSize: Math.min(Number(req.query.pageSize) || 25, 200),
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '',
        searchId: req.query.searchId || null,
        hasEmail: req.query.hasEmail === '1',
      })
    )
  } catch (err) {
    handle(res, next, err)
  }
})

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await getLead(req.user.id, req.params.id))
  } catch (err) {
    handle(res, next, err)
  }
})

export default router
