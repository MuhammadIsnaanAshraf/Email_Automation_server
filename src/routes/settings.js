import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import { getUserSendSettings } from '../services/campaigns.js'

const router = Router()

router.use(requireAuth)

/* GET /settings — the user's own sending limits (daily cap + inter-send gap),
   read from user_settings. Read-only for the user: these are controlled by the
   platform/admin, not editable here. */
router.get('/', async (req, res, next) => {
  try {
    const settings = await getUserSendSettings(req.user.id)
    res.json({ settings })
  } catch (err) {
    next(err)
  }
})

export default router
