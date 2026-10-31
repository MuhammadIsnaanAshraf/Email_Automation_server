import { env } from '../config/env.js'

/* Minimal in-memory fixed-window rate limiter, keyed by client IP. The
   process is a single Node instance, so no shared store is needed; a restart
   simply clears the windows, which is harmless for an anti-spam guard.

   Used for open (unauthenticated) routes only. Authenticated routes are
   already scoped to a user and must not be throttled here. */
export function rateLimit({ windowMs, max, name = 'route' } = {}) {
  const window = Math.max(1000, Number(windowMs) || 60_000)
  const limit = Math.max(1, Number(max) || 10)
  const hits = new Map()

  return function rateLimiter(req, res, next) {
    const now = Date.now()
    const key = req.ip || req.socket?.remoteAddress || 'unknown'

    if (hits.size > 10_000) {
      for (const [ip, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(ip)
      }
    }

    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + window }
      hits.set(key, entry)
    }

    entry.count += 1
    const remaining = Math.max(0, limit - entry.count)
    const retryAfter = Math.max(0, Math.ceil((entry.resetAt - now) / 1000))

    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(retryAfter))

    if (entry.count > limit) {
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests to /${name}. Try again in ${retryAfter}s.`,
      })
    }

    next()
  }
}

/* The public keep-alive endpoint is unauthenticated by design, so its only
   defence is this limiter. One daily cron plus a little slack is plenty. */
export const keepaliveLimiter = rateLimit({
  windowMs: env.keepalive.windowMs,
  max: env.keepalive.max,
  name: 'keepalive',
})
