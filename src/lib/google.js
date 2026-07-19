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
export async function refreshAccessToken(refreshToken) {
  const client = makeOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await client.refreshAccessToken()
  return credentials // { access_token, expiry_date, scope, ... }
}