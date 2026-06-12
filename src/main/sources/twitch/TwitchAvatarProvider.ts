import type { ApiClient } from '@twurple/api'

/** Debounce window for collecting unseen logins before one batched Helix lookup. */
const BATCH_DELAY_MS = 2_000
/** Helix `/users` accepts at most 100 logins per call. */
const BATCH_LIMIT = 100
/** Cached avatars kept before the oldest entries are evicted (FIFO). */
const CACHE_LIMIT = 2_000

/**
 * Caches Twitch chatters' profile images (IRC doesn't carry them; Helix `/users` does). Unseen
 * logins from arriving messages are collected and resolved in one debounced, batched call, so
 * avatars attach to a chatter's *later* messages — the same lazy pattern as channel emotes.
 * Helix needs a user token, so this only runs while logged in (the source gates the resolver).
 */
export class TwitchAvatarProvider {
  readonly #api: () => ApiClient | undefined
  /** Called per login when a batched lookup lands, so earlier messages can be back-filled. */
  readonly #onResolved: ((login: string, url: string) => void) | undefined
  /** login → profile image URL, insertion-ordered for FIFO eviction. */
  readonly #avatars = new Map<string, string>()
  /** Logins awaiting the next batched lookup. */
  readonly #queued = new Set<string>()
  #timer: NodeJS.Timeout | undefined

  constructor(api: () => ApiClient | undefined, onResolved?: (login: string, url: string) => void) {
    this.#api = api
    this.#onResolved = onResolved
  }

  /** The cached avatar for a login; an unseen login is queued for the next batched lookup. */
  resolve(login: string): string | undefined {
    const cached = this.#avatars.get(login)
    if (cached === undefined && !this.#queued.has(login)) {
      this.#queued.add(login)
      this.#timer ??= setTimeout(() => void this.#flush(), BATCH_DELAY_MS)
    }
    return cached
  }

  /** Cancel the pending batch (source disconnecting). The cache survives for a reconnect. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#queued.clear()
  }

  async #flush(): Promise<void> {
    this.#timer = undefined
    const logins = [...this.#queued].slice(0, BATCH_LIMIT)
    for (const login of logins) {
      this.#queued.delete(login)
    }
    if (this.#queued.size > 0) {
      this.#timer = setTimeout(() => void this.#flush(), BATCH_DELAY_MS)
    }
    const api = this.#api()
    if (api === undefined || logins.length === 0) {
      return
    }
    try {
      const users = await api.users.getUsersByNames(logins)
      for (const user of users) {
        if (this.#store(user.name, user.profilePictureUrl)) {
          this.#onResolved?.(user.name, user.profilePictureUrl)
        }
      }
    } catch {
      // Dropped — each login re-queues with that chatter's next message (a natural retry).
    }
  }

  #store(login: string, url: string): boolean {
    if (url === '') {
      return false
    }
    this.#avatars.set(login, url)
    while (this.#avatars.size > CACHE_LIMIT) {
      const oldest = this.#avatars.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.#avatars.delete(oldest)
    }
    return true
  }
}
