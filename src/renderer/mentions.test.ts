import { describe, expect, it } from 'vitest'
import type { ChatMessage, Platform } from '@shared/model'
import { findMentionToken, matchChatters, recentChatters } from '@renderer/mentions'

let next = 0
function said(
  platform: Platform,
  author: { id: string; name: string; displayName: string },
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  next += 1
  return {
    id: `m${next}`,
    platform,
    channelId: `${platform}:chan`,
    timestamp: next,
    author: { ...author, badges: [], roles: { broadcaster: false, moderator: false } },
    fragments: [{ type: 'text', text: 'hi' }],
    ...extra
  }
}

const ada = { id: '1001', name: 'ada_l', displayName: 'Ada_L' }
const bob = { id: '1002', name: 'bobby99', displayName: 'ボブ' }
const ytCara = { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: '@cara', displayName: '@cara' }

describe('recentChatters', () => {
  it('lists each account once, most recent first', () => {
    const list = recentChatters([
      said('twitch', ada),
      said('twitch', bob),
      said('twitch', ada),
      said('youtube', ytCara)
    ])
    expect(list.map((c) => c.key)).toEqual([
      'youtube:UCaaaaaaaaaaaaaaaaaaaaaa',
      'twitch:1001',
      'twitch:1002'
    ])
  })

  it('identifies by account id, so a rename is one entry with the newest name', () => {
    const list = recentChatters([
      said('twitch', ada),
      said('twitch', { ...ada, name: 'ada_new', displayName: 'Ada_New' })
    ])
    expect(list).toHaveLength(1)
    expect(list[0]?.insert).toBe('@Ada_New')
  })

  it('inserts the Twitch login when the display name is a different word', () => {
    const [entry] = recentChatters([said('twitch', bob)])
    expect(entry?.insert).toBe('@bobby99')
    expect(entry?.login).toBe('bobby99')
  })

  it('keeps the display capitalisation when it is the login', () => {
    const [entry] = recentChatters([said('twitch', ada)])
    expect(entry?.insert).toBe('@Ada_L')
    expect(entry?.login).toBeUndefined()
  })

  it('inserts a YouTube handle without doubling the @', () => {
    expect(recentChatters([said('youtube', ytCara)])[0]?.insert).toBe('@cara')
    const plain = { id: 'UCbbbbbbbbbbbbbbbbbbbbbb', name: 'Dee', displayName: 'Dee' }
    expect(recentChatters([said('youtube', plain)])[0]?.insert).toBe('@Dee')
  })

  it('skips system notices and authorless lines', () => {
    const list = recentChatters([
      said('twitch', ada, { system: true }),
      said('twitch', { id: '', name: '', displayName: '' })
    ])
    expect(list).toEqual([])
  })

  it('stops at the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      said('twitch', { id: `id${i}`, name: `u${i}`, displayName: `u${i}` })
    )
    expect(recentChatters(many, 5).map((c) => c.displayName)).toEqual([
      'u19',
      'u18',
      'u17',
      'u16',
      'u15'
    ])
  })

  it('returns nothing for an empty buffer', () => {
    expect(recentChatters([])).toEqual([])
  })
})

describe('findMentionToken', () => {
  it('finds the @partial at the caret', () => {
    expect(findMentionToken('hey @ad', 7)).toEqual({ start: 4, query: 'ad' })
    expect(findMentionToken('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('ignores an @ inside a word, such as an email address', () => {
    expect(findMentionToken('me@example', 10)).toBeUndefined()
  })

  it('ends at whitespace before the caret', () => {
    expect(findMentionToken('@ada hello', 10)).toBeUndefined()
  })

  it('reads only up to the caret', () => {
    expect(findMentionToken('@adalovelace', 4)).toEqual({ start: 0, query: 'ada' })
  })
})

describe('matchChatters', () => {
  const list = recentChatters([
    said('twitch', { id: '1', name: 'xada', displayName: 'xada' }),
    said('twitch', bob),
    said('youtube', ytCara),
    said('twitch', ada)
  ])

  it('puts prefix matches before substring matches, recency within each', () => {
    expect(matchChatters('ada', list, 10).map((c) => c.displayName)).toEqual(['Ada_L', 'xada'])
  })

  it('matches the login behind a non-Latin display name', () => {
    expect(matchChatters('bob', list, 10).map((c) => c.insert)).toEqual(['@bobby99'])
  })

  it('matches a YouTube handle without its @, case-insensitively', () => {
    expect(matchChatters('CA', list, 10).map((c) => c.insert)).toEqual(['@cara'])
  })

  it('offers the most recent chatters for a bare @, up to the limit', () => {
    expect(matchChatters('', list, 2)).toHaveLength(2)
  })

  it('returns nothing when no one matches', () => {
    expect(matchChatters('zzz', list, 10)).toEqual([])
  })
})
