import { supabase } from '../lib/supabase.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { refreshAccessToken } from '../lib/google.js'

/* The Gmail-sending grant for a user. Tokens are encrypted at rest; the rest of
   the app reads `status` to know whether the connection is healthy. */

export async function saveConnection(userId, tokens) {
  console.log("🚀 ~ saveConnection ~ userId:", userId)
  console.log("🚀 ~ saveConnection ~ tokens:", tokens)
  const scopes = tokens.scope ? tokens.scope.split(' ') : 
                 tokens.scopes ? tokens.scopes : []
  console.log("🚀 ~ saveConnection ~ scopes:", scopes)

  // Google only returns a refresh_token on the first consent (or when we force
  // prompt=consent). Never overwrite a stored one with null.
  const row = {
    user_id: userId,
    access_token: encrypt(tokens.access_token),
    token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() :
                  tokens.expires_at ? new Date(tokens.expires_at * 1000).toISOString() : null,
    scopes,
    status: 'connected',
    last_error: null,
    updated_at: new Date().toISOString(),
  }
  if (tokens.refresh_token) {
    row.refresh_token = encrypt(tokens.refresh_token)
  }

  const { error } = await supabase
    .from('google_connections')
    .upsert(row, { onConflict: 'user_id' })
    console.log("🚀 ~ saveConnection ~ error:", error)
  if (error) throw error
}

export async function getConnection(userId) {
  const { data, error } = await supabase
    .from('google_connections')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error) return null
  return data
}

/* Public-facing view of the connection — safe to send to the frontend. Never
   includes the tokens themselves. This is what powers the "reconnect" prompt. */
export function toPublicStatus(connection) {
  console.log("🚀 ~ toPublicStatus ~ connection:", connection)
  if (!connection) {
    return { status: 'disconnected', canSendEmail: false, needsReconnect: true }
  }
  const canSendEmail =
    connection.status === 'connected' &&
    connection.scopes?.includes('https://www.googleapis.com/auth/gmail.send')
  return {
    status: connection.status,
    canSendEmail,
    needsReconnect: connection.status !== 'connected' || !canSendEmail,
    scopes: connection.scopes || [],
    connectedAt: connection.connected_at,
    lastError: connection.last_error || null,
  }
}

async function markStatus(userId, status, lastError = null) {
  await supabase
    .from('google_connections')
    .update({ status, last_error: lastError, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

/* Return a valid Gmail access token for the user, refreshing if needed.
   This is the function the email-sending module will call. If the
   grant is gone, we mark the connection so the UI can prompt a reconnect
   instead of the send failing silently later.

   Returns { accessToken } on success, or { error, needsReconnect } on failure. */
export async function getValidAccessToken(userId) {
  const connection = await getConnection(userId)
  if (!connection) {
    return { error: 'no_connection', needsReconnect: true }
  }

  // Still-valid access token (60s safety margin)? Use it.
  const expiry = connection.token_expiry ? new Date(connection.token_expiry).getTime() : 0
  if (connection.access_token && expiry - 60_000 > Date.now()) {
    return { accessToken: decrypt(connection.access_token) }
  }

  const refreshToken = decrypt(connection.refresh_token)
  if (!refreshToken) {
    await markStatus(userId, 'expired', 'No refresh token on file; user must reconnect.')
    return { error: 'no_refresh_token', needsReconnect: true }
  }

  try {
    const credentials = await refreshAccessToken(refreshToken)
    await saveConnection(userId, { ...credentials, refresh_token: undefined })
    return { accessToken: credentials.access_token }
  } catch (err) {
    // invalid_grant → the user revoked access or the token expired.
    const revoked = err?.response?.data?.error === 'invalid_grant'
    await markStatus(
      userId,
      revoked ? 'revoked' : 'error',
      err?.response?.data?.error_description || err.message
    )
    return { error: revoked ? 'revoked' : 'refresh_failed', needsReconnect: true }
  }
}