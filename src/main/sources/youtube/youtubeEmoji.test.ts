import { describe, expect, it } from 'vitest'
import { collectEmojis, emojiSendMap, toResolvedEmotes } from '@main/sources/youtube/youtubeEmoji'

const entries = [
  // Standard unicode emoji (emojiId is the character) — skipped.
  { emojiId: '🇬🇧', shortcuts: [':flag_gb:'], image: { thumbnails: [{ url: 'noto', width: 72 }] } },
  // Proprietary global emoji — kept, largest thumbnail chosen.
  {
    emojiId: 'UCx/aaa',
    shortcuts: [':face-blue-smiling:'],
    image: {
      thumbnails: [
        { url: 'small', width: 24 },
        { url: 'big', width: 48 }
      ]
    }
  },
  // Channel member emoji — kept.
  {
    emojiId: 'UCx/bbb',
    shortcuts: [':member:'],
    isCustomEmoji: true,
    image: { thumbnails: [{ url: 'm', width: 32 }] }
  },
  // No image — skipped.
  { emojiId: 'UCx/ccc', shortcuts: [':noimg:'] },
  // No emojiId — skipped.
  { shortcuts: [':noid:'], image: { thumbnails: [{ url: 'x', width: 24 }] } }
]

describe('collectEmojis', () => {
  it('keeps only proprietary emojis with a shortcut and image', () => {
    expect(collectEmojis(entries)).toEqual([
      { shortcut: ':face-blue-smiling:', emojiId: 'UCx/aaa', url: 'big' },
      { shortcut: ':member:', emojiId: 'UCx/bbb', url: 'm' }
    ])
  })

  it('finds emojis nested anywhere in a response and dedupes by shortcut', () => {
    const response = {
      continuationContents: {
        liveChatContinuation: {
          actionPanel: { liveChatMessageInputRenderer: { pickers: entries } },
          actions: [
            // The same emoji used in a message run — deduped.
            { addChatItemAction: { item: { runs: [{ emoji: entries[1] }] } } }
          ]
        }
      }
    }
    expect(collectEmojis(response).map((emoji) => emoji.shortcut)).toEqual([
      ':face-blue-smiling:',
      ':member:'
    ])
  })

  it('returns [] for non-object/empty input', () => {
    expect(collectEmojis(undefined)).toEqual([])
    expect(collectEmojis({})).toEqual([])
    expect(collectEmojis(null)).toEqual([])
  })
})

describe('toResolvedEmotes and emojiSendMap', () => {
  const emojis = collectEmojis(entries)

  it('maps to picker emotes under the youtube provider', () => {
    expect(toResolvedEmotes(emojis)).toEqual([
      {
        code: ':face-blue-smiling:',
        provider: 'youtube',
        url: 'big',
        zeroWidth: false,
        animated: false
      },
      { code: ':member:', provider: 'youtube', url: 'm', zeroWidth: false, animated: false }
    ])
  })

  it('builds the shortcut → emojiId send map', () => {
    expect(emojiSendMap(emojis)).toEqual(
      new Map([
        [':face-blue-smiling:', 'UCx/aaa'],
        [':member:', 'UCx/bbb']
      ])
    )
  })
})
