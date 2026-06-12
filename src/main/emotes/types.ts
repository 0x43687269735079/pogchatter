import type { EmoteProvider } from '@shared/model'

/** An emote resolved to everything the renderer needs (third-party, Twitch native, or YouTube emoji). */
export interface ResolvedEmote {
  code: string
  provider: EmoteProvider
  url: string
  /** Overlay/zero-width emote that stacks on the preceding emote. */
  zeroWidth: boolean
  animated: boolean
}
