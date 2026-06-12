import type { ResolvedEmote } from '@main/emotes/types'
import { getJson } from '@main/emotes/httpJson'

const CDN = 'https://cdn.7tv.app/emote'
const FLAG_ACTIVE_ZERO_WIDTH = 1 // ActiveEmoteFlagModel.ZeroWidth
const FLAG_EMOTE_ZERO_WIDTH = 256 // EmoteFlagsModel.ZeroWidth

interface SevenTvEmoteData {
  animated?: boolean
  flags?: number
}
export interface SevenTvActiveEmote {
  id: string
  name: string
  flags?: number
  data?: SevenTvEmoteData
}
interface SevenTvEmoteSet {
  id?: string
  emotes?: SevenTvActiveEmote[]
}
interface SevenTvUser {
  emote_set?: SevenTvEmoteSet
}

/** A 7TV emote set with its id retained, so the EventAPI can subscribe to live updates. */
export interface SevenTvSet {
  setId: string | undefined
  emotes: ResolvedEmote[]
}

/** Map a 7TV active emote (REST and EventAPI dispatches share the shape) to the engine's shape. */
export function resolveActiveEmote(active: SevenTvActiveEmote): ResolvedEmote {
  const activeFlags = active.flags ?? 0
  const emoteFlags = active.data?.flags ?? 0
  return {
    code: active.name,
    provider: '7tv',
    url: `${CDN}/${active.id}/2x.webp`,
    zeroWidth:
      (activeFlags & FLAG_ACTIVE_ZERO_WIDTH) !== 0 || (emoteFlags & FLAG_EMOTE_ZERO_WIDTH) !== 0,
    animated: active.data?.animated === true
  }
}

function toSet(set: SevenTvEmoteSet | undefined): SevenTvSet {
  return {
    setId: typeof set?.id === 'string' && set.id !== '' ? set.id : undefined,
    emotes: (set?.emotes ?? []).map(resolveActiveEmote)
  }
}

export async function fetchSevenTvGlobal(): Promise<SevenTvSet> {
  const data = await getJson<SevenTvEmoteSet>('https://7tv.io/v3/emote-sets/global')
  return toSet(data ?? undefined)
}

export async function fetchSevenTvChannel(
  platform: 'twitch' | 'youtube',
  id: string
): Promise<SevenTvSet> {
  const data = await getJson<SevenTvUser>(
    `https://7tv.io/v3/users/${platform}/${encodeURIComponent(id)}`
  )
  // Include every emote in the channel's active set, including unlisted/unapproved ones
  // (`data.listed === false`). Unlike clients that hide them by default, we render them for
  // maximum coverage — anything a channel actually added is something chatters can use.
  return toSet(data?.emote_set)
}
