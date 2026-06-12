import { describe, expect, it } from 'vitest'
import type { ChannelEmote } from '@shared/model'
import {
  type EmojiCatalog,
  buildSuggestions,
  findActiveToken,
  groupEmoteSets
} from '@renderer/emoji'

describe('findActiveToken', () => {
  it('returns the token when the caret follows :partial at a word boundary', () => {
    const value = 'hello :smi'
    expect(findActiveToken(value, value.length)).toEqual({ start: 6, query: 'smi' })
  })

  it('treats a start-of-string colon as a boundary', () => {
    expect(findActiveToken(':fire', 5)).toEqual({ start: 0, query: 'fire' })
  })

  it('ignores a colon not preceded by whitespace (e.g. URLs)', () => {
    expect(findActiveToken('http://x', 8)).toBeUndefined()
  })

  it('returns undefined when whitespace separates the caret from the colon', () => {
    expect(findActiveToken(':fire ok', 8)).toBeUndefined()
  })

  it('only considers the token up to the caret', () => {
    expect(findActiveToken(':smile rest', 4)).toEqual({ start: 0, query: 'smi' })
  })
})

const catalog: EmojiCatalog = {
  categories: [],
  search: (query, limit) =>
    (query === 'fire'
      ? [{ native: '🔥', shortcode: 'fire', shortcodes: ['fire'], keywords: [], name: 'Fire' }]
      : []
    ).slice(0, limit)
}

const emotes: ChannelEmote[] = [
  { code: 'KEKW', url: 'http://e/kekw', provider: '7tv', animated: true, scope: 'channel' },
  { code: 'keepo', url: 'http://e/keepo', provider: 'bttv', animated: false, scope: 'global' }
]

describe('buildSuggestions', () => {
  it('matches custom emotes case-insensitively by prefix', () => {
    const out = buildSuggestions('kek', emotes, catalog, 10)
    expect(out[0]).toMatchObject({ kind: 'emote', insert: 'KEKW' })
  })

  it('includes standard emoji after custom emotes', () => {
    const out = buildSuggestions('fire', emotes, catalog, 10)
    expect(out.some((s) => s.kind === 'emoji' && s.insert === '🔥')).toBe(true)
  })

  it('caps at the limit with emotes first', () => {
    const out = buildSuggestions('ke', emotes, catalog, 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('emote')
  })

  it('ranks channel emotes ahead of global at the same match rank', () => {
    const both: ChannelEmote[] = [
      { code: 'pogG', url: 'http://e/g', provider: 'bttv', animated: false, scope: 'global' },
      { code: 'pogC', url: 'http://e/c', provider: '7tv', animated: false, scope: 'channel' }
    ]
    const out = buildSuggestions('pog', both, catalog, 10)
    expect(out[0]).toMatchObject({ insert: 'pogC' })
  })
})

describe('groupEmoteSets', () => {
  it('orders channel sets before global, grouped by provider', () => {
    const mixed: ChannelEmote[] = [
      { code: 'g7', url: 'u', provider: '7tv', animated: false, scope: 'global' },
      { code: 'cB', url: 'u', provider: 'bttv', animated: false, scope: 'channel' },
      { code: 'c7', url: 'u', provider: '7tv', animated: false, scope: 'channel' }
    ]
    const sets = groupEmoteSets(mixed)
    expect(sets.map((s) => s.id)).toEqual(['channel:7tv', 'channel:bttv', 'global:7tv'])
    expect(sets[0]?.label).toBe('7TV · Channel')
  })

  it('omits empty sets', () => {
    const sets = groupEmoteSets([
      { code: 'x', url: 'u', provider: 'ffz', animated: false, scope: 'global' }
    ])
    expect(sets).toHaveLength(1)
    expect(sets[0]?.id).toBe('global:ffz')
  })

  it('orders Twitch sets before third-party providers', () => {
    const sets = groupEmoteSets([
      { code: 'a', url: 'u', provider: '7tv', animated: false, scope: 'channel' },
      { code: 'b', url: 'u', provider: 'twitch', animated: false, scope: 'channel' }
    ])
    expect(sets.map((s) => s.id)).toEqual(['channel:twitch', 'channel:7tv'])
    expect(sets[0]?.label).toBe('Twitch · Channel')
  })

  it('orders channel before library before global, and labels the library set', () => {
    const sets = groupEmoteSets([
      { code: 'g', url: 'u', provider: '7tv', animated: false, scope: 'global' },
      { code: 'l', url: 'u', provider: '7tv', animated: false, scope: 'library' },
      { code: 'c', url: 'u', provider: '7tv', animated: false, scope: 'channel' }
    ])
    expect(sets.map((s) => s.id)).toEqual(['channel:7tv', 'library:7tv', 'global:7tv'])
    expect(sets[1]?.label).toBe('7TV · Library')
  })
})
