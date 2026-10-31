import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { requireActiveAccount } from '../middleware/accountStatus.js'
import { requireActiveSubscription } from '../middleware/subscription.js'
import { env } from '../config/env.js'
import {
  CreatorError,
  MARKETS,
  createSearch,
  listSearches,
  getSearch,
  listCreators,
} from '../services/creators.js'

const router = Router()

router.use(requireAuth, requireActiveAccount)

function handle(res, next, err) {
  if (err instanceof CreatorError) return res.status(err.status).json({ error: err.message })
  return next(err)
}

/* GET /creators/searches — recent searches plus the form's limits. */
router.get('/searches', async (req, res, next) => {
  try {
    res.json({
      searches: await listSearches(req.user.id),
      maxPerKeyword: env.creators.maxPerKeyword,
      markets: MARKETS,
    })
  } catch (err) {
    handle(res, next, err)
  }
})

/* POST /creators/searches
     { keywords: string[], country?: 'GB', period?: 'last30Day'|'last7Day'|'lastDay',
       perKeyword, minRevenue?, minFollowers?, findEmails?: true }
   Returns 202 with the 'running' search; poll GET /creators/searches/:id.
   Spends provider credit, so it sits behind the subscription gate. */
router.post('/searches', requireActiveSubscription, async (req, res, next) => {
  try {
    res.status(202).json(await createSearch(req.user.id, req.body || {}))
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

/* GET /creators?sort=revenue|followers|growth|units|recent&dir=&search=&searchId=&hasEmail=1&page=&pageSize= */
router.get('/', async (req, res, next) => {
  try {
    res.json(
      await listCreators(req.user.id, {
        page: Math.max(1, Number(req.query.page) || 1),
        pageSize: Math.min(Number(req.query.pageSize) || 25, 200),
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '',
        searchId: req.query.searchId || null,
        hasEmail: req.query.hasEmail === '1',
        sort: req.query.sort || 'revenue',
        dir: req.query.dir === 'asc' ? 'asc' : 'desc',
      })
    )
  } catch (err) {
    handle(res, next, err)
  }
})

export default router
