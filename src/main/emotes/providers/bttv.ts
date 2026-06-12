import type { ResolvedEmote } from '@main/emotes/types'
import { getJson } from '@main/emotes/httpJson'

const CDN = 'https://cdn.betterttv.net/emote'

interface BttvEmote {
  id: string
  code: string
  imageType?: string
  animated?: boolean
}
interface BttvChannel {
  channelEmotes?: BttvEmote[]
  sharedEmotes?: BttvEmote[]
}

function toResolved(emote: BttvEmote): ResolvedEmote {
  return {
    code: emote.code,
    provider: 'bttv',
    url: `${CDN}/${emote.id}/2x`,
    zeroWidth: false,
    animated: emote.animated === true || emote.imageType === 'gif'
  }
}

export async function fetchBttvGlobal(): Promise<ResolvedEmote[]> {
  const data = await getJson<BttvEmote[]>('https://api.betterttv.net/3/cached/emotes/global')
  return Array.isArray(data) ? data.map(toResolved) : []
}

export async function fetchBttvChannel(
  platform: 'twitch' | 'youtube',
  id: string
): Promise<ResolvedEmote[]> {
  const data = await getJson<BttvChannel>(
    `https://api.betterttv.net/3/cached/users/${platform}/${encodeURIComponent(id)}`
  )
  if (!data) {
    return []
  }
  return [...(data.channelEmotes ?? []), ...(data.sharedEmotes ?? [])].map(toResolved)
}
