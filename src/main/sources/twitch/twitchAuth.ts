import { proxiedFetch } from '@main/net/proxy'

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'

export interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface TwitchTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the token was obtained. */
  obtainmentTimestamp: number
  /** Seconds from obtainment until expiry (as returned by Twitch). */
  expiresIn: number
  scopes: string[]
  userId: string
  userName: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string[]
}

/**
 * Twitch definitively rejected the credentials (token endpoint 4xx): the refresh token or
 * device code is dead and only a re-login can recover. Every other failure from these
 * helpers (network rejection, 5xx, 429) is transient and safe to retry with the same inputs.
 */
export class TwitchAuthRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwitchAuthRejectedError'
  }
}

interface ValidateResponse {
  user_id: string
  login: string
  scopes?: string[]
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  }
}

export async function requestDeviceCode(clientId: string, scopes: string[]): Promise<DeviceCode> {
  const response = await proxiedFetch(
    DEVICE_URL,
    form({ client_id: clientId, scopes: scopes.join(' ') })
  )
  if (!response.ok) {
    throw new Error(`Twitch device-code request failed (${response.status})`)
  }
  return (await response.json()) as DeviceCode
}

/** One poll of the device-token endpoint. Returns tokens, `'pending'`, or throws on a fatal error. */
export async function pollDeviceToken(
  clientId: string,
  deviceCode: string,
  scopes: string[]
): Promise<TwitchTokens | 'pending'> {
  const response = await proxiedFetch(
    TOKEN_URL,
    form({
      client_id: clientId,
      scopes: scopes.join(' '),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  )
  if (response.status === 400) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string }
    // authorization_pending and slow_down are soft polling errors (RFC 8628) — keep polling, don't abort.
    if (
      detail.message === undefined ||
      detail.message.includes('authorization_pending') ||
      detail.message.includes('slow_down')
    ) {
      return 'pending'
    }
    // The user denied the request or the device code expired — polling can never succeed.
    throw new TwitchAuthRejectedError(`Twitch authorization failed: ${detail.message}`)
  }
  if (!response.ok) {
    throw new Error(`Twitch token request failed (${response.status})`)
  }
  return buildTokens((await response.json()) as TokenResponse)
}

/**
 * Refresh an access token. Public clients (device flow) refresh without a secret.
 *
 * Identity and scopes carry over from `previous` instead of a VALIDATE round-trip: a refresh
 * cannot change the account, and Twitch rotates the refresh token on success — a transient
 * VALIDATE failure after that rotation would discard the only copy of the new token.
 * Throws {@link TwitchAuthRejectedError} when Twitch rejects the refresh token outright.
 */
export async function refreshTokens(
  clientId: string,
  previous: TwitchTokens
): Promise<TwitchTokens> {
  const response = await proxiedFetch(
    TOKEN_URL,
    form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: previous.refreshToken })
  )
  if (response.status === 400 || response.status === 401) {
    throw new TwitchAuthRejectedError(`Twitch rejected the refresh token (${response.status})`)
  }
  if (!response.ok) {
    throw new Error(`Twitch token refresh failed (${response.status})`)
  }
  const data = (await response.json()) as TokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    obtainmentTimestamp: Date.now(),
    expiresIn: data.expires_in,
    scopes: data.scope ?? previous.scopes,
    userId: previous.userId,
    userName: previous.userName
  }
}

async function buildTokens(data: TokenResponse): Promise<TwitchTokens> {
  const response = await proxiedFetch(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${data.access_token}` }
  })
  if (!response.ok) {
    throw new Error(`Twitch token validation failed (${response.status})`)
  }
  const info = (await response.json()) as ValidateResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    obtainmentTimestamp: Date.now(),
    expiresIn: data.expires_in,
    scopes: data.scope ?? info.scopes ?? [],
    userId: info.user_id,
    userName: info.login
  }
}
