import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { keepaliveLimiter } from '../middleware/rateLimit.js'

const router = Router()

/* GET /keepalive — public, deliberately unauthenticated.

   Supabase pauses free projects after ~1 week with no activity. An external
   cron calls this once a day so the project stays awake. It must actually
   touch Postgres to count as activity, so it issues a tiny HEAD count against
   a table that always exists (no rows are read or returned).

   Safety: no user data is exposed, errors are swallowed into a generic 503,
   and a per-IP rate limit stops anyone who discovers the URL from turning it
   into a DB hammer. */
router.get('/', keepaliveLimiter, async (_req, res) => {
  try {
    const { error } = await supabase
      .from('system_logs')
      .select('id', { head: true })
      .limit(1)

    if (error) throw error
    res.json({ ok: true })
  } catch (err) {
    console.error('[keepalive] database ping failed:', err.message)
    res.status(503).json({ ok: false })
  }
})

export default router
