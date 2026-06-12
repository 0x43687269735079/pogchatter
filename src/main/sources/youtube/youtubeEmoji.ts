import type { ResolvedEmote } from '@main/emotes/types'

/** A proprietary YouTube emoji: its `:shortcut:`, image, and the id needed to send it. */
export interface YouTubeEmoji {
  /** The `:shortcut:` form, e.g. `:face-blue-smiling:`. */
  shortcut: string
  /** The send id (channel-id/hash) — required so a sent emoji renders as an image, not text. */
  emojiId: string
  url: string
}

interface RawImage {
  thumbnails?: Array<{ url?: string; width?: number }>
}

function largestThumb(image: RawImage | undefined): string {
  let best: { url?: string; width?: number } | undefined
  for (const thumb of image?.thumbnails ?? []) {
    if (best === undefined || (thumb.width ?? 0) > (best.width ?? 0)) {
      best = thumb
    }
  }
  return best?.url ?? ''
}

/**
 * One proprietary YouTube emoji from a raw emoji object, or undefined if it isn't one. Only emojis
 * whose `emojiId` is a channel-id/hash (contains `/`) qualify — standard unicode emojis carry their
 * character as the id and need no special handling (they're typed/sent as the character).
 */
function emojiFromEntry(obj: Record<string, unknown>): YouTubeEmoji | undefined {
  const emojiId = obj['emojiId']
  const shortcuts = obj['shortcuts']
  if (typeof emojiId !== 'string' || !emojiId.includes('/') || !Array.isArray(shortcuts)) {
    return undefined
  }
  const shortcut = shortcuts[0]
  const url = largestThumb(obj['image'] as RawImage | undefined)
  if (typeof shortcut !== 'string' || shortcut === '' || url === '') {
    return undefined
  }
  return { shortcut, emojiId, url }
}

/**
 * Every proprietary YouTube emoji anywhere in a response, deduped by shortcut. Walks the whole tree
 * so it finds them wherever they sit — the authed message-input emoji picker, and the emojis used in
 * the recent messages the same response carries — without depending on the exact (undocumented) path.
 */
export function collectEmojis(data: unknown): YouTubeEmoji[] {
  const found = new Map<string, YouTubeEmoji>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
      }
      return
    }
    if (node === null || typeof node !== 'object') {
      return
    }
    const obj = node as Record<string, unknown>
    const emoji = emojiFromEntry(obj)
    if (emoji !== undefined && !found.has(emoji.shortcut)) {
      found.set(emoji.shortcut, emoji)
    }
    for (const value of Object.values(obj)) {
      visit(value)
    }
  }
  visit(data)
  return [...found.values()]
}

/** Picker entries for a YouTube emoji catalog (inserting one types its `:shortcut:`). */
export function toResolvedEmotes(emojis: YouTubeEmoji[]): ResolvedEmote[] {
  return emojis.map((emoji) => ({
    code: emoji.shortcut,
    provider: 'youtube',
    url: emoji.url,
    zeroWidth: false,
    animated: false
  }))
}

/** Map of `:shortcut:` → emojiId, for converting typed shortcuts to emoji segments when sending. */
export function emojiSendMap(emojis: YouTubeEmoji[]): Map<string, string> {
  return new Map(emojis.map((emoji) => [emoji.shortcut, emoji.emojiId]))
}
