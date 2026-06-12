import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import { searchMessages } from '@renderer/search'

function msg(
  id: string,
  channelId: string,
  timestamp: number,
  text: string,
  author = 'Alice'
): ChatMessage {
  return {
    id,
    platform: 'youtube',
    channelId,
    timestamp,
    author: {
      id: author,
      name: `@${author.toLowerCase()}`,
      displayName: author,
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text }]
  }
}

const byChannel = {
  a: [msg('a1', 'a', 10, 'hello world'), msg('a2', 'a', 30, 'GG everyone', 'Bob')],
  b: [msg('b1', 'b', 20, 'world peace'), msg('b2', 'b', 40, 'nothing here')]
}

describe('searchMessages', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(searchMessages('', false, ['a', 'b'], byChannel, 100)).toEqual([])
    expect(searchMessages('   ', false, ['a', 'b'], byChannel, 100)).toEqual([])
  })

  it('matches message text case-insensitively across chats, time-ordered', () => {
    expect(searchMessages('WORLD', false, ['a', 'b'], byChannel, 100).map((m) => m.id)).toEqual([
      'a1',
      'b1'
    ])
  })

  it('matches by author name', () => {
    expect(searchMessages('bob', false, ['a', 'b'], byChannel, 100).map((m) => m.id)).toEqual([
      'a2'
    ])
  })

  it('supports regex queries', () => {
    expect(searchMessages('everyone$', true, ['a', 'b'], byChannel, 100).map((m) => m.id)).toEqual([
      'a2'
    ])
  })

  it('treats an invalid regex as no match', () => {
    expect(searchMessages('(', true, ['a', 'b'], byChannel, 100)).toEqual([])
  })

  it('keeps only the most recent `cap` matches', () => {
    expect(searchMessages('world', false, ['a', 'b'], byChannel, 1).map((m) => m.id)).toEqual([
      'b1'
    ])
  })

  it('ignores channels with no buffered messages', () => {
    expect(searchMessages('world', false, ['a', 'gone'], byChannel, 100).map((m) => m.id)).toEqual([
      'a1'
    ])
  })
})
