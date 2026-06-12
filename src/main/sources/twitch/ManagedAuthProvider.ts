import type { AccessTokenMaybeWithUserId, AccessTokenWithUserId, AuthProvider } from '@twurple/auth'
import type { TwitchTokens } from '@main/sources/twitch/twitchAuth'

/**
 * twurple `AuthProvider` backed by {@link TwitchAuthManager}. It returns a
 * freshly-validated token every time twurple asks (which is on each connect /
 * reconnect), so the chat session survives access-token expiry across reconnects
 * without a periodic timer — `ensureValid()` refreshes on demand using the
 * long-lived refresh token. Returns `null` when logged out.
 */
export class ManagedAuthProvider implements AuthProvider {
  readonly clientId: string
  readonly #ensureValid: () => Promise<void>
  readonly #getTokens: () => TwitchTokens | undefined
  readonly #forceRefresh: () => Promise<void>

  constructor(
    clientId: string,
    ensureValid: () => Promise<void>,
    getTokens: () => TwitchTokens | undefined,
    forceRefresh: () => Promise<void>
  ) {
    this.clientId = clientId
    this.#ensureValid = ensureValid
    this.#getTokens = getTokens
    this.#forceRefresh = forceRefresh
  }

  getCurrentScopesForUser(): string[] {
    return this.#getTokens()?.scopes ?? []
  }

  async getAccessTokenForUser(): Promise<AccessTokenWithUserId | null> {
    return this.#current()
  }

  async getAccessTokenForIntent(): Promise<AccessTokenWithUserId | null> {
    return this.#current()
  }

  async getAnyAccessToken(): Promise<AccessTokenMaybeWithUserId> {
    const token = await this.#current()
    if (token === null) {
      throw new Error('No Twitch access token available')
    }
    return token
  }

  /**
   * twurple's recovery hook for a token that the clock says is valid but Twitch rejects (e.g.
   * revoked on twitch.tv): force a refresh through the manager and hand back the result, or throw
   * so twurple surfaces `onTokenFetchFailure`.
   */
  async refreshAccessTokenForIntent(): Promise<AccessTokenWithUserId> {
    await this.#forceRefresh()
    const token = await this.#current()
    if (token === null) {
      throw new Error('Twitch token refresh failed — log in to Twitch again')
    }
    return token
  }

  async #current(): Promise<AccessTokenWithUserId | null> {
    await this.#ensureValid()
    const tokens = this.#getTokens()
    if (tokens === undefined) {
      return null
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scope: tokens.scopes,
      expiresIn: tokens.expiresIn,
      obtainmentTimestamp: tokens.obtainmentTimestamp,
      userId: tokens.userId
    }
  }
}
