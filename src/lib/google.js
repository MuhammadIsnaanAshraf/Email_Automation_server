import { google } from 'googleapis'
import { env } from '../config/env.js'

/* Build a fresh OAuth2 client. We create one per request rather than sharing a
   singleton so that per-user tokens never leak between requests. */
export function makeOAuthClient() {
  return new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, env.google.redirectUri)
}

/* Given a stored refresh token, mint a fresh access token. Throws if Google has
   revoked or invalidated the grant — callers translate that into a 'revoked'
   connection status so the user is prompted to reconnect. */
// Network-level failures (DNS/connect/timeout) never reached Google, so they
// carry no OAuth verdict — unlike a 4xx response, they say nothing about
// whether the grant is still valid. Callers must not treat these as a reason
// to prompt reconnect.
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

export async function refreshAccessToken(refreshToken) {
  const client = makeOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  try {
    const { credentials } = await client.refreshAccessToken()
    return credentials
  } catch (err) {
    console.error('Error refreshing access token:', err?.response?.data || err)

    if (!err?.response && TRANSIENT_CODES.has(err?.code || err?.error?.code)) {
      const error = new Error(err.message || 'Token refresh failed: network error')
      error.response = { data: { error: 'network_error', error_description: error.message } }
      throw error
    }

    const body = err?.response?.data || {}
    const isInvalidGrant = body.error === 'invalid_grant'
    const error = new Error(body.error_description || body.error || err.message || 'Token refresh failed')
    error.response = { data: { error: isInvalidGrant ? 'invalid_grant' : 'refresh_failed', error_description: error.message } }
    throw error
  }
}