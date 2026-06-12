import type { ResolvedEmote } from '@main/emotes/types'
import { getJson } from '@main/emotes/httpJson'

interface FfzEmote {
  id: number
  name: string
  urls?: Record<string, string>
  animated?: Record<string, string> | null
}
interface FfzSet {
  emoticons?: FfzEmote[]
}
interface FfzGlobal {
  default_sets?: number[]
  sets?: Record<string, FfzSet>
}
interface FfzRoom {
  room?: { set?: number }
  sets?: Record<string, FfzSet>
}

function ensureHttps(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

function toResolved(emote: FfzEmote): ResolvedEmote {
  const animated = emote.animated ?? undefined
  const url =
    animated?.['2'] ??
    animated?.['1'] ??
    emote.urls?.['2'] ??
    emote.urls?.['1'] ??
    emote.urls?.['4'] ??
    ''
  return {
    code: emote.name,
    provider: 'ffz',
    url: ensureHttps(url),
    zeroWidth: false,
    animated: animated != null
  }
}

export async function fetchFfzGlobal(): Promise<ResolvedEmote[]> {
  const data = await getJson<FfzGlobal>('https://api.frankerfacez.com/v1/set/global')
  if (!data) {
    return []
  }
  const out: ResolvedEmote[] = []
  for (const setId of data.default_sets ?? []) {
    const set = data.sets?.[String(setId)]
    for (const emote of set?.emoticons ?? []) {
      out.push(toResolved(emote))
    }
  }
  return out
}

export async function fetchFfzChannel(
  platform: 'twitch' | 'youtube',
  id: string
): Promise<ResolvedEmote[]> {
  const encoded = encodeURIComponent(id)
  const path = platform === 'youtube' ? `room/yt/${encoded}` : `room/id/${encoded}`
  const data = await getJson<FfzRoom>(`https://api.frankerfacez.com/v1/${path}`)
  const setId = data?.room?.set
  if (!data || setId === undefined) {
    return []
  }
  const set = data.sets?.[String(setId)]
  return (set?.emoticons ?? []).map(toResolved)
}
