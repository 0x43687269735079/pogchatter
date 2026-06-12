import type { AuthProvider } from '@twurple/auth'
import type { AuthStore } from '@main/auth/AuthStore'
import { ManagedAuthProvider } from '@main/sources/twitch/ManagedAuthProvider'
import {
  pollDeviceToken,
  refreshTokens,
  requestDeviceCode,
  TwitchAuthRejectedError,
  type DeviceCode,
  type TwitchTokens
} from '@main/sources/twitch/twitchAuth'

// user:read:emotes lets us list the emotes this account can send (subs/follower/bits)
// for the picker; it's additive, so a prior login without it still works (degrades to
// global + channel emotes until the next re-login).
// The moderator:manage scopes power the right-click remove/timeout/ban actions, and
// user:read:moderated_channels their role check — additive too: a pre-moderation login
// still chats, and the action path tells the user to re-login when Helix rejects it.
const SCOPES = [
  'chat:read',
  'chat:edit',
  'user:read:emotes',
  'user:read:moderated_channels',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages'
]
const STORE_KEY = 'twitch'
const REFRESH_MARGIN_MS = 60_000
const FORCE_REFRESH_GUARD_MS = 30_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Holds Twitch user credentials (device-code flow, public client) and hands out
 * a `StaticAuthProvider` for sending. `onChange` fires when login state changes,
 * so the app can reconnect Twitch sources and refresh the UI.
 */
export class TwitchAuthManager {
  readonly #clientId: string | undefined
  readonly #store: AuthStore
  readonly #onChange: () => void
  #tokens: TwitchTokens | undefined
  // Monotonic id of the latest login attempt; older polls notice the bump and abandon.
  #loginAttempt = 0
  #lastRefreshCompleted = 0
  #refreshing: Promise<void> | undefined
  // Bumped by logout() so an in-flight refresh can't resurrect cleared credentials.
  #epoch = 0

  constructor(clientId: string | undefined, store: AuthStore, onChange: () => void) {
    this.#clientId = clientId
    this.#store = store
    this.#onChange = onChange
    this.#tokens = store.get<TwitchTokens>(STORE_KEY)
  }

  get configured(): boolean {
    return this.#clientId !== undefined
  }

  get isLoggedIn(): boolean {
    return this.#tokens !== undefined
  }

  get userName(): string | undefined {
    return this.#tokens?.userName
  }

  /** The Twitch app Client-Id, for Helix calls (badge/emote images). */
  get clientId(): string | undefined {
    return this.#clientId
  }

  /** The logged-in user's Twitch id, for Helix calls scoped to this account. */
  get userId(): string | undefined {
    return this.#tokens?.userId
  }

  /** Scopes granted to the current token (a pre-emote-scope login lacks `user:read:emotes`). */
  get scopes(): string[] {
    return this.#tokens?.scopes ?? []
  }

  /** A currently-valid user access token for Helix calls, or undefined when logged out. */
  async accessToken(): Promise<string | undefined> {
    await this.ensureValid()
    return this.#tokens?.accessToken
  }

  getAuthProvider(): AuthProvider | undefined {
    if (this.#tokens === undefined || this.#clientId === undefined) {
      return undefined
    }
    // Backed by the manager so twurple gets a freshly-refreshed token on each (re)connect.
    // The forced-refresh hook powers twurple's recovery for revoked-but-unexpired tokens.
    return new ManagedAuthProvider(
      this.#clientId,
      () => this.ensureValid(),
      () => this.#tokens,
      () => this.handleAuthFailure()
    )
  }

  /**
   * Refresh the token if it's expired or about to expire. A definitive rejection (the refresh
   * token is dead) clears the login; a transient failure keeps it for the next caller to retry.
   */
  async ensureValid(): Promise<void> {
    if (this.#tokens === undefined || this.#clientId === undefined) {
      return
    }
    const expiresAt = this.#tokens.obtainmentTimestamp + this.#tokens.expiresIn * 1000
    if (expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return
    }
    // Single-flight: concurrent callers (startup + each reconnect) share one refresh,
    // so a rotated refresh token is never spent twice.
    this.#refreshing ??= this.#refresh(this.#clientId, this.#tokens)
    await this.#refreshing
  }

  async #refresh(clientId: string, tokens: TwitchTokens): Promise<void> {
    const epoch = this.#epoch
    try {
      const refreshed = await refreshTokens(clientId, tokens)
      if (epoch !== this.#epoch) {
        // The user logged out while this refresh was in flight; the logout wins.
        return
      }
      this.#tokens = refreshed
      this.#store.set(STORE_KEY, refreshed)
      this.#lastRefreshCompleted = Date.now()
    } catch (error) {
      if (epoch !== this.#epoch) {
        return
      }
      if (error instanceof TwitchAuthRejectedError) {
        // The refresh token is dead — only a re-login can recover. #clear's onChange
        // reconnects sources (anonymous read-only) and updates the UI to logged-out.
        this.#clear()
      }
      // Transient (network/5xx): keep the tokens and the store; the next caller retries.
    } finally {
      this.#refreshing = undefined
    }
  }

  /** Reactive backstop after an auth failure: force a refresh, or require re-login if a fresh token still fails. */
  async handleAuthFailure(): Promise<void> {
    const clientId = this.#clientId
    const tokens = this.#tokens
    if (tokens === undefined || clientId === undefined) {
      return
    }
    const inFlight = this.#refreshing
    if (inFlight !== undefined) {
      // The failure predates the pending refresh's outcome — share it rather than
      // double-spending the rotated refresh token with a second request.
      await inFlight
      return
    }
    if (Date.now() - this.#lastRefreshCompleted < FORCE_REFRESH_GUARD_MS) {
      // A token refreshed moments ago is still rejected → credentials are bad; require re-login.
      this.#clear()
      return
    }
    const refresh = this.#refresh(clientId, tokens)
    this.#refreshing = refresh
    await refresh
    if (this.#tokens !== undefined && this.#tokens !== tokens) {
      // The forced refresh produced a new token; reconnect sources so they pick it up.
      this.#onChange()
    }
  }

  /**
   * Begin device-code login. `onPrompt` receives the code to show; polling continues in the
   * background. A new call supersedes any attempt still polling — without that, a closed login
   * dialog would lock login out ("already in progress") until the old code expired (~30 minutes).
   */
  async login(onPrompt: (code: DeviceCode) => void): Promise<void> {
    if (this.#clientId === undefined) {
      throw new Error(
        'Twitch sending needs TWITCH_CLIENT_ID (create a free app at dev.twitch.tv/console/apps)'
      )
    }
    const attempt = ++this.#loginAttempt
    const superseded = (): boolean => attempt !== this.#loginAttempt
    const device = await requestDeviceCode(this.#clientId, SCOPES)
    if (superseded()) {
      throw new Error('Twitch login superseded by a newer attempt')
    }
    onPrompt(device)
    const deadline = Date.now() + device.expires_in * 1000
    while (Date.now() < deadline) {
      await wait(device.interval * 1000)
      if (superseded()) {
        throw new Error('Twitch login superseded by a newer attempt')
      }
      let result: TwitchTokens | 'pending'
      try {
        result = await pollDeviceToken(this.#clientId, device.device_code, SCOPES)
      } catch (error) {
        if (error instanceof TwitchAuthRejectedError) {
          // The user denied the request or the code expired — polling can never succeed.
          throw error
        }
        // Transient poll failure (network blip, 5xx): keep polling until the code expires.
        continue
      }
      if (result !== 'pending') {
        if (superseded()) {
          // A newer attempt owns the flow now — don't commit a stale grant under it.
          throw new Error('Twitch login superseded by a newer attempt')
        }
        this.#tokens = result
        this.#store.set(STORE_KEY, result)
        this.#onChange()
        return
      }
    }
    throw new Error('Twitch login timed out')
  }

  logout(): void {
    this.#epoch += 1
    // Logging out also abandons any device-code poll still running.
    this.#loginAttempt += 1
    this.#clear()
  }

  #clear(): void {
    this.#tokens = undefined
    this.#store.delete(STORE_KEY)
    this.#onChange()
  }
}
