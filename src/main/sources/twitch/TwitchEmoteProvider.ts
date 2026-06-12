import { proxiedFetch } from '@main/net/proxy'
import type { ResolvedEmote } from '@main/emotes/types'

const HELIX = 'https://api.twitch.tv/helix'
const USER_EMOTE_PAGES = 20
const DEFAULT_TEMPLATE =
  'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}'

interface HelixEmote {
  id: string
  name: string
  format: string[]
  scale: string[]
  theme_mode: string[]
}
interface HelixEmoteResponse {
  data?: HelixEmote[]
  template?: string
  pagination?: { cursor?: string }
}

/** Build the CDN URL for one emote from Helix's `template`, preferring animated/dark/2x. */
export function emoteFromHelix(raw: HelixEmote, template: string): ResolvedEmote {
  const animated = raw.format.includes('animated')
  const scale = raw.scale.includes('2.0') ? '2.0' : (raw.scale[0] ?? '1.0')
  const theme = raw.theme_mode.includes('dark') ? 'dark' : (raw.theme_mode[0] ?? 'light')
  const url = template
    .replace('{{id}}', raw.id)
    .replace('{{format}}', animated ? 'animated' : 'static')
    .replace('{{theme_mode}}', theme)
    .replace('{{scale}}', scale)
  return { code: raw.name, provider: 'twitch', url, zeroWidth: false, animated }
}

/**
 * Fetches the Twitch native emote catalogs from Helix for the input picker/autocomplete:
 * global emotes, the channel's emotes, and (with the `user:read:emotes` scope) the
 * emotes this account is entitled to send. Helix requires a Client-Id and a user token,
 * so callers pass them in; any failure (including a missing scope → 401) yields `[]`.
 */
export class TwitchEmoteProvider {
  fetchGlobal(token: string, clientId: string): Promise<ResolvedEmote[]> {
    return this.#fetchPage(`${HELIX}/chat/emotes/global`, token, clientId)
  }

  fetchChannel(roomId: string, token: string, clientId: string): Promise<ResolvedEmote[]> {
    const url = `${HELIX}/chat/emotes?broadcaster_id=${encodeURIComponent(roomId)}`
    return this.#fetchPage(url, token, clientId)
  }

  /** All emotes the account can send (paginated). Returns `[]` if the scope wasn't granted. */
  async fetchUser(userId: string, token: string, clientId: string): Promise<ResolvedEmote[]> {
    const out: ResolvedEmote[] = []
    let cursor: string | undefined
    for (let page = 0; page < USER_EMOTE_PAGES; page += 1) {
      const base = `${HELIX}/chat/emotes/user?user_id=${encodeURIComponent(userId)}`
      const url = cursor === undefined ? base : `${base}&after=${encodeURIComponent(cursor)}`
      const body = await this.#fetchRaw(url, token, clientId)
      if (body === undefined) {
        break
      }
      const template = body.template ?? DEFAULT_TEMPLATE
      for (const raw of body.data ?? []) {
        out.push(emoteFromHelix(raw, template))
      }
      cursor = body.pagination?.cursor
      if (cursor === undefined || cursor === '') {
        break
      }
    }
    return out
  }

  async #fetchPage(url: string, token: string, clientId: string): Promise<ResolvedEmote[]> {
    const body = await this.#fetchRaw(url, token, clientId)
    if (body === undefined) {
      return []
    }
    const template = body.template ?? DEFAULT_TEMPLATE
    return (body.data ?? []).map((raw) => emoteFromHelix(raw, template))
  }

  async #fetchRaw(
    url: string,
    token: string,
    clientId: string
  ): Promise<HelixEmoteResponse | undefined> {
    try {
      const response = await proxiedFetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
      })
      if (!response.ok) {
        return undefined
      }
      return (await response.json()) as HelixEmoteResponse
    } catch {
      return undefined
    }
  }
}
