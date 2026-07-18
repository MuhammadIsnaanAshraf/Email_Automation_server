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
}

/* The single OAuth scope set we request. Login (identity) + Gmail send are
   granted together in one consent screen, exactly as the product requires. */
export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.send',
]

export const SESSION_COOKIE = 'fs_session'
