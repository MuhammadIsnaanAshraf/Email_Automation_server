import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'
import authRoutes from './routes/auth.js'
import listRoutes from './routes/lists.js'
import templateRoutes from './routes/templates.js'
import campaignRoutes from './routes/campaigns.js'

const app = express()

app.set('trust proxy', 1)

app.use(
  cors({
    origin: env.frontendUrl,
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

app.use((err, _req, res, _next) => {
  console.error('[error]', err)
  res.status(500).json({ error: 'internal_error' })
})

app.listen(env.port, () => {
  console.log(`FlowState backend listening on ${env.backendUrl} (port ${env.port})`)
})