import { Router } from 'express'
import { requireAuth } from '../middleware/supabaseAuth.js'
import {
  AgencyError,
  signupAgency,
  getAgencySummary,
  listMembers,
  removeMember,
  buildConnectUrl,
} from '../services/agencies.js'

const router = Router()

function handle(res, next, err) {
  if (err instanceof AgencyError) return res.status(err.status).json({ error: err.message, code: err.code })
  return next(err)
}

/* POST /agency/signup  { name, email, password } — public. Creates the login
   in 'pending'; it can sign in straight away but can't attach accounts until
   an admin approves it. */
router.post('/signup', async (req, res, next) => {
  try {
    const agency = await signupAgency({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
    })
    res.status(201).json(agency)
  } catch (err) {
    handle(res, next, err)
  }
})

/* Everything below is for the agency login itself. If the client also sent
   X-Account-Id, requireAuth has already verified it and parked the agency on
   req.agency — either way, `agencyId` is the agency. */
function requireAgency(req, res, next) {
  const agencyId = req.agency?.id || (req.user?.accountType === 'agency' ? req.user.id : null)
  if (!agencyId) return res.status(403).json({ error: 'Agency accounts only.', code: 'not_agency' })
  req.agencyId = agencyId
  next()
}

router.use(requireAuth, requireAgency)

/* GET /agency/me — status, limit and how many accounts are attached. Works in
   every status so a pending/rejected agency can be told where it stands. */
router.get('/me', async (req, res, next) => {
  try {
    const agency = await getAgencySummary(req.agencyId)
    if (!agency) return res.status(404).json({ error: 'Agency not found.' })
    res.json(agency)
  } catch (err) {
    handle(res, next, err)
  }
})

router.get('/accounts', async (req, res, next) => {
  try {
    res.json({ accounts: await listMembers(req.agencyId) })
  } catch (err) {
    handle(res, next, err)
  }
})

/* POST /agency/accounts/connect  { accountId? } — Google consent URL to
   attach a new account, or with accountId to reconnect an attached one. */
router.post('/accounts/connect', async (req, res, next) => {
  try {
    const memberId = req.body?.accountId || null
    if (memberId) {
      const members = await listMembers(req.agencyId)
      if (!members.some((m) => m.id === memberId)) {
        throw new AgencyError('That account is not attached to your agency.', 404)
      }
    }
    res.json({ url: await buildConnectUrl(req.agencyId, { memberId }) })
  } catch (err) {
    handle(res, next, err)
  }
})

/* DELETE /agency/accounts/:id — detach. The account and its campaigns keep
   running; the agency just can't open it any more. */
router.delete('/accounts/:id', async (req, res, next) => {
  try {
    await removeMember(req.agencyId, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    handle(res, next, err)
  }
})

export default router
