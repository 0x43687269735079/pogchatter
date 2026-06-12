import { proxiedFetch } from '@main/net/proxy'

const HELIX = 'https://api.twitch.tv/helix'

interface HelixCheermoteTier {
  min_bits: number
  images?: {
    dark?: { animated?: Record<string, string>; static?: Record<string, string> }
  }
}
interface HelixCheermote {
  prefix: string
  tiers?: HelixCheermoteTier[]
}
interface HelixCheermoteResponse {
  data?: HelixCheermote[]
}

/** One usable tier: its bits threshold and the chosen image. */
interface CheermoteTier {
  minBits: number
  url: string
  animated: boolean
}

/** The art for one cheer, picked by the tier its bits amount falls into. */
export interface CheermoteArt {
  url: string
  animated: boolean
}

/** Lowercased prefix → tiers sorted by min_bits descending. */
type CheermoteMap = Map<string, CheermoteTier[]>

/**
 * Resolves cheermote art from Helix (`/bits/cheermotes`). Helix requires a Client-Id and a user
 * token, so cheermotes only render while logged in; without them, cheers stay plain text. Global
 * cheermotes (Cheer, PogChamp, ...) load once per process; a channel's response also carries its
 * custom cheermotes, loaded per room.
 */
export class TwitchCheermoteProvider {
  #global: CheermoteMap | undefined
  readonly #channels = new Map<string, CheermoteMap>()

  async ensureGlobal(token: string, clientId: string): Promise<void> {
    if (this.#global !== undefined) {
      return
    }
    const map = await this.#fetch(`${HELIX}/bits/cheermotes`, token, clientId)
    if (map !== undefined) {
      this.#global = map
    }
  }

  async ensureChannel(roomId: string, token: string, clientId: string): Promise<void> {
    if (this.#channels.has(roomId)) {
      return
    }
    const map = await this.#fetch(
      `${HELIX}/bits/cheermotes?broadcaster_id=${encodeURIComponent(roomId)}`,
      token,
      clientId
    )
    if (map !== undefined) {
      this.#channels.set(roomId, map)
    }
  }

  /**
   * Every known cheermote prefix for this room, lowercased — twurple's chat-message parser
   * matches candidates against a lowercase name list. The broadcaster response includes the
   * global set, so the channel map alone is complete once loaded; the global map covers rooms
   * whose channel fetch hasn't landed yet.
   */
  names(roomId: string | undefined): string[] {
    const map = (roomId !== undefined ? this.#channels.get(roomId) : undefined) ?? this.#global
    return map === undefined ? [] : [...map.keys()]
  }

  /** The image for `name` at the tier `bits` falls into, when known. */
  resolve(roomId: string | undefined, name: string, bits: number): CheermoteArt | undefined {
    const key = name.toLowerCase()
    const tiers =
      (roomId !== undefined ? this.#channels.get(roomId)?.get(key) : undefined) ??
      this.#global?.get(key)
    if (tiers === undefined) {
      return undefined
    }
    for (const tier of tiers) {
      if (bits >= tier.minBits) {
        return { url: tier.url, animated: tier.animated }
      }
    }
    return undefined
  }

  async #fetch(url: string, token: string, clientId: string): Promise<CheermoteMap | undefined> {
    try {
      const response = await proxiedFetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
      })
      if (!response.ok) {
        return undefined
      }
      const body = (await response.json()) as HelixCheermoteResponse
      const map: CheermoteMap = new Map()
      for (const raw of body.data ?? []) {
        const tiers: CheermoteTier[] = []
        for (const tier of raw.tiers ?? []) {
          const dark = tier.images?.dark
          const animated = dark?.animated?.['2'] ?? dark?.animated?.['1']
          const still = dark?.static?.['2'] ?? dark?.static?.['1']
          const image = animated ?? still
          if (image !== undefined) {
            tiers.push({ minBits: tier.min_bits, url: image, animated: animated !== undefined })
          }
        }
        tiers.sort((a, b) => b.minBits - a.minBits)
        map.set(raw.prefix.toLowerCase(), tiers)
      }
      return map
    } catch {
      // undefined = "fetch failed" so callers retry, vs. an empty map = "no cheermotes" (cached).
      return undefined
    }
  }
}
