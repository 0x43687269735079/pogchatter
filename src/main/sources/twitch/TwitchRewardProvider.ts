import { proxiedFetch } from '@main/net/proxy'

const GQL_URL = 'https://gql.twitch.tv/gql'
// Twitch's public web client id, used anonymously to read the public channel-points reward catalog
// — the same query the web client issues for logged-out viewers. This is NOT the app's own OAuth
// client id; it carries no user identity and grants no extra access.
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const REWARD_QUERY =
  'query($login:String!){user(login:$login){channel{communityPointsSettings{customRewards{id title}}}}}'

interface RewardCatalogResponse {
  data?: {
    user?: {
      channel?: {
        communityPointsSettings?: {
          customRewards?: { id?: unknown; title?: unknown }[]
        } | null
      } | null
    } | null
  }
}

/** Reward UUID → human title, for one channel. */
type RewardMap = Map<string, string>

/**
 * Resolves Twitch channel-points custom-reward names (the reward's UUID → its title). Twitch's IRC
 * redemption messages carry only the reward's `custom-reward-id` UUID, and the documented Helix
 * endpoint is broadcaster-only, so the name for a channel you're merely watching is read from
 * Twitch's public GraphQL reward catalog — the same data the web client shows logged-out viewers.
 *
 * Anonymous and cached once per channel. A failed fetch returns nothing (and isn't cached, so a
 * later connect retries); a channel with no custom rewards caches an empty map. When the name can't
 * be resolved, the redemption simply renders without it.
 */
export class TwitchRewardProvider {
  readonly #channels = new Map<string, RewardMap>()

  /** Load a channel's reward catalog once (keyed by login). Safe to call on every connect. */
  async ensureChannel(login: string): Promise<void> {
    if (this.#channels.has(login)) {
      return
    }
    const map = await this.#fetch(login)
    if (map !== undefined) {
      this.#channels.set(login, map)
    }
  }

  /** The reward's title for this channel, once the catalog has loaded and contains the id. */
  resolve(login: string, rewardId: string): string | undefined {
    return this.#channels.get(login)?.get(rewardId)
  }

  async #fetch(login: string): Promise<RewardMap | undefined> {
    try {
      const response = await proxiedFetch(GQL_URL, {
        method: 'POST',
        headers: { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: REWARD_QUERY, variables: { login } })
      })
      if (!response.ok) {
        return undefined
      }
      const body = (await response.json()) as RewardCatalogResponse
      const rewards = body.data?.user?.channel?.communityPointsSettings?.customRewards
      if (!Array.isArray(rewards)) {
        // A malformed/empty response (channel gone, points disabled) — undefined lets a later
        // connect retry, vs. a valid empty list below which caches "no custom rewards".
        return undefined
      }
      const map: RewardMap = new Map()
      for (const reward of rewards) {
        if (typeof reward.id === 'string' && typeof reward.title === 'string') {
          map.set(reward.id, reward.title)
        }
      }
      return map
    } catch {
      return undefined
    }
  }
}
