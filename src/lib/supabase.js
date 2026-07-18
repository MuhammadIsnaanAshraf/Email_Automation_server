import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { env } from '../config/env.js'

/* supabase-js eagerly constructs a realtime client that needs a global
   WebSocket. Node < 22 doesn't provide one, so polyfill it. We don't use
   realtime, but this avoids a startup crash. */
if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket
}

/* Server-side Supabase client using the SERVICE ROLE key. This bypasses Row
   Level Security, so it must never be exposed to the browser — it lives only
   on the backend. Sessions/auth are handled by us, not Supabase Auth, so we
   disable the client's own session persistence. */
export const supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
})
