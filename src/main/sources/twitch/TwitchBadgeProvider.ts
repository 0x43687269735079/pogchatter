import { proxiedFetch } from '@main/net/proxy'

const HELIX = 'https://api.twitch.tv/helix'

interface HelixBadgeVersion {
  id: string
  image_url_2x?: string
  image_url_4x?: string
  image_url_1x?: string
}
interface HelixBadgeSet {
  set_id: string
  versions: HelixBadgeVersion[]
}
interface HelixBadgeResponse {
  data?: HelixBadgeSet[]
}

/** set id → (version id → image URL) */
type SetMap = Map<string, Map<string, string>>

/**
 * Resolves Twitch chat-badge images from Helix (`/chat/badges/*`). Helix requires
 * a Client-Id and a user token, so images are only available while logged in; with
 * no token, callers fall back to the letter chips. Global badges (broadcaster, mod,
 * VIP, ...) load once per process; channel badges (subscriber, bits) load per room.
 */
export class TwitchBadgeProvider {
  #global: SetMap | undefined
  readonly #channels = new Map<string, SetMap>()

  async ensureGlobal(token: string, clientId: string): Promise<void> {
    if (this.#global !== undefined) {
      return
    }
    const sets = await this.#fetchSets(`${HELIX}/chat/badges/global`, token, clientId)
    if (sets !== undefined) {
      this.#global = sets
    }
  }

  async ensureChannel(roomId: string, token: string, clientId: string): Promise<void> {
    if (this.#channels.has(roomId)) {
      return
    }
    const sets = await this.#fetchSets(
      `${HELIX}/chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`,
      token,
      clientId
    )
    if (sets !== undefined) {
      this.#channels.set(roomId, sets)
    }
  }

  /** Channel art wins over global (subscriber/bits badges are channel-specific). */
  resolve(roomId: string | undefined, setId: string, version: string): string | undefined {
    const channel =
      roomId !== undefined ? this.#channels.get(roomId)?.get(setId)?.get(version) : undefined
    return channel ?? this.#global?.get(setId)?.get(version)
  }

  async #fetchSets(url: string, token: string, clientId: string): Promise<SetMap | undefined> {
    try {
      const response = await proxiedFetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
      })
      if (!response.ok) {
        return undefined
      }
      const body = (await response.json()) as HelixBadgeResponse
      const sets: SetMap = new Map()
      for (const set of body.data ?? []) {
        const versions = new Map<string, string>()
        for (const version of set.versions) {
          const image = version.image_url_2x ?? version.image_url_4x ?? version.image_url_1x
          if (image !== undefined) {
            versions.set(version.id, image)
          }
        }
        sets.set(set.set_id, versions)
      }
      return sets
    } catch {
      // undefined = "fetch failed" so callers retry, vs. an empty map = "no badges" (cached).
      return undefined
    }
  }
}
