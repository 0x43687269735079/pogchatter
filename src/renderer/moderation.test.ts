import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModerationRule } from '@shared/model'
import { isFlagged } from '@renderer/moderation'

function message(text: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm',
    platform: 'youtube',
    channelId: 'c',
    timestamp: 0,
    author: {
      id: 'u',
      name: '@alice',
      displayName: 'Alice',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text }],
    ...over
  }
}

const rule = (over: Partial<ModerationRule>): ModerationRule => ({
  pattern: '',
  isRegex: false,
  ...over
})

describe('isFlagged', () => {
  it('flags a message containing a watchlist word (case-insensitive)', () => {
    expect(isFlagged(message('please STOP spamming'), [rule({ pattern: 'spam' })])).toBe(true)
    expect(isFlagged(message('all good here'), [rule({ pattern: 'spam' })])).toBe(false)
  })

  it('supports regex terms', () => {
    expect(
      isFlagged(message('buy followers at scam.biz'), [
        rule({ pattern: '\\bscam\\b', isRegex: true })
      ])
    ).toBe(true)
  })

  it('treats an invalid regex as no match (no throw)', () => {
    expect(isFlagged(message('('), [rule({ pattern: '(', isRegex: true })])).toBe(false)
  })

  it('ignores empty patterns and never flags system lines', () => {
    expect(isFlagged(message('anything'), [rule({ pattern: '' })])).toBe(false)
    expect(isFlagged(message('spam', { system: true }), [rule({ pattern: 'spam' })])).toBe(false)
  })

  it('matches emote codes as part of the message text', () => {
    const m = message('gg', {
      fragments: [
        { type: 'text', text: 'gg' },
        {
          type: 'emote',
          code: ':scam:',
          url: 'u',
          provider: '7tv',
          zeroWidth: false,
          animated: false
        }
      ]
    })
    expect(isFlagged(m, [rule({ pattern: ':scam:' })])).toBe(true)
  })
})
