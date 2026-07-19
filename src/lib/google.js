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

/* Look up the real expiry and granted scopes for a Google access token. Used
   right after OAuth sign-in: Supabase hands us the provider access token but
   not its expiry or scopes, so we ask Google directly. */
export async function getTokenInfo(accessToken) {
  const client = makeOAuthClient()
  return client.getTokenInfo(accessToken) // { expiry_date, scopes, ... }
}