import dotenv from 'dotenv'

dotenv.config()

/* Read + validate environment once at startup. If a required variable is missing
   we fail loudly here rather than deep inside a request later. */
function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See backend/.env.example`)
  }
  return value
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  adminUrl: process.env.ADMIN_URL || 'http://localhost:5174',
  backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    get redirectUri() {
      return `${env.backendUrl}/auth/google/callback`
    },
  },

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 30),

  sending: {
    // Platform-wide fallback gap between two consecutive emails, in seconds.
    // Used when a campaign carries no explicit frequency AND the account has
    // no per-user override (user_settings.send_gap_seconds). 120s matches the
    // "1 every 2 minutes" that used to be hardcoded in the frontend, so
    // existing behaviour is unchanged until someone configures otherwise.
    defaultGapSeconds: clampGapSeconds(process.env.SEND_DEFAULT_GAP_SECONDS, 120),
  },

  leads: {
    // Provider API tokens, tried in order. When one hits its monthly limit the
    // next is used for the same search. Optional: with none set, the lead
    // finder reports itself unavailable and everything else runs normally.
    apifyTokens: (process.env.APIFY_TOKENS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    actorId: process.env.APIFY_LEADS_ACTOR_ID || 'T1XDXWc1L92AfIJtd',
    maxPerSearch: Math.max(1, Math.min(Number(process.env.LEADS_MAX_PER_SEARCH) || 500, 5000)),
  },

  creators: {
    // TikTok Shop creator discovery: market, keyword, sales (GMV).
    discoveryActorId: process.env.APIFY_CREATORS_ACTOR_ID || 'lergassy~tiktok-shop-creators-scraper',
    // Contact-email lookup by handle for creators discovery found without one.
    emailActorId: process.env.APIFY_CREATOR_EMAIL_ACTOR_ID || 'sPFBcsiarHy9ykU2b',
    // Ask discovery for the shop's own contact data (email etc.). Much pricier
    // per row and not available on the free Apify plan; the email stage finds
    // most addresses anyway.
    discoveryWithContacts: process.env.CREATORS_DISCOVERY_WITH_CONTACTS === 'true',
    maxPerKeyword: Math.max(1, Math.min(Number(process.env.CREATORS_MAX_PER_KEYWORD) || 100, 1000)),
  },

  agency: {
    // Sub-account limit a newly signed-up agency starts with. Admins change it
    // per agency afterwards (agencies.max_sub_accounts).
    defaultMaxSubAccounts: Math.max(0, Math.min(Number(process.env.AGENCY_DEFAULT_MAX_SUB_ACCOUNTS) || 5, 1000)),
  },

  keepalive: {
    // Per-IP throttle on the public GET /keepalive route. It exists only so an
    // external daily cron keeps the Supabase project awake; these bounds leave
    // plenty of room for that while stopping anyone who finds it from spamming
    // the database.
    windowMs: Math.max(1000, Number(process.env.KEEPALIVE_RATE_WINDOW_MS) || 60_000),
    max: Math.max(1, Number(process.env.KEEPALIVE_RATE_MAX) || 10),
  },
}

/* Keep any gap (env or per-user) inside the same sane window the DB check
   constraint enforces: at least 1s, at most 24h. A junk/absent env value
   falls back to `fallback` rather than silently becoming NaN and producing
   Invalid Date send times downstream. */
export function clampGapSeconds(value, fallback = 120) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), 86400)
}

/* The single OAuth scope set we request. Login (identity), Gmail send and
   Gmail read are granted together in one consent screen.

   gmail.readonly is what makes bounce and block detection possible at all.
   Gmail's send API returns 200 for practically every message — it accepts the
   mail and only learns it was refused when the receiving server says so, and
   that refusal arrives as a delivery-status notice in the SENDER's own
   mailbox. Without read access there is no way to know a message bounced, only
   ways to guess, and a wrong guess suppresses a real customer permanently.

   Accounts connected before this scope was added keep working for sending; the
   bounce scanner records 'missing_scope' against them and the app prompts a
   reconnect. See GMAIL_READ_SCOPE below. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  GMAIL_SEND_SCOPE,
  GMAIL_READ_SCOPE,
]

export const SESSION_COOKIE = 'fs_session'
