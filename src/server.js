import dns from 'node:dns'
import net from 'node:net'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'

// Google's OAuth/Gmail endpoints resolve dual-stack (A + AAAA), and this host
// has no IPv6 route at all. `ipv4first` alone isn't enough: Node's "Happy
// Eyeballs" auto-family-selection (on by default since Node 18.13/19.4) still
// races a v6 attempt alongside v4, and when v6 is entirely unroutable (not
// just slow) that race can misfire and kill the whole connection attempt as
// ETIMEDOUT in under a second — confirmed by reproducing it directly against
// oauth2.googleapis.com. Disabling auto-family-selection makes every outbound
// connection just use the (now IPv4-first-ordered) address, which is reliable.
dns.setDefaultResultOrder('ipv4first')
net.setDefaultAutoSelectFamily(false)
import authRoutes from './routes/auth.js'
import listRoutes from './routes/lists.js'
import templateRoutes from './routes/templates.js'
import campaignRoutes from './routes/campaigns.js'
import adminRoutes from './routes/admin.js'
import subscriptionRoutes from './routes/subscriptions.js'
import settingsRoutes from './routes/settings.js'

const app = express()

app.set('trust proxy', 1)

// Two separate SPAs call this API (the main app and the admin console), each
// on its own origin/port — a single hardcoded `origin` here would silently
// CORS-block whichever one isn't listed (the browser fails the request
// before it's even sent, so it shows up downstream as an inexplicable auth
// failure, not a CORS error).
const ALLOWED_ORIGINS = [env.frontendUrl, env.adminUrl]
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header (curl, server-to-server, same-origin) — allow.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
      callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    credentials: true,
  })
)
app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => res.json({ ok: true, service: 'flowstate-backend' }))

app.use('/auth', authRoutes)
app.use('/lists', listRoutes)
app.use('/templates', templateRoutes)
app.use('/campaigns', campaignRoutes)
app.use('/admin', adminRoutes)
app.use('/subscriptions', subscriptionRoutes)
app.use('/settings', settingsRoutes)

app.use((err, _req, res, _next) => {
  console.error('[error]', err)
  res.status(500).json({ error: 'internal_error' })
})

app.listen(env.port, () => {
  console.log(`FlowState backend listening on ${env.backendUrl} (port ${env.port})`)
})