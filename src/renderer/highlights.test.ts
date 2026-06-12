import { describe, expect, it } from 'vitest'
import type { ChatMessage, HighlightRule } from '@shared/model'
import { matchHighlight, messageText } from '@renderer/highlights'

function message(over: Partial<ChatMessage> = {}): ChatMessage {
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
    fragments: [{ type: 'text', text: 'hello world' }],
    ...over
  }
}

const rule = (over: Partial<HighlightRule>): HighlightRule => ({
  pattern: '',
  isRegex: false,
  target: 'user',
  ...over
})

describe('matchHighlight', () => {
  it('matches a user rule against the handle (case-insensitive)', () => {
    expect(matchHighlight(message(), [rule({ pattern: 'ALICE', target: 'user' })])).toMatchObject({
      flash: true,
      sound: true,
      notify: false
    })
  })

  it('matches a message rule against the text, not the author', () => {
    expect(matchHighlight(message(), [rule({ pattern: 'world', target: 'message' })])).toBeDefined()
    expect(
      matchHighlight(message(), [rule({ pattern: 'alice', target: 'message' })])
    ).toBeUndefined()
  })

  it('supports regex and applies the rule colour + alert overrides', () => {
    const hit = matchHighlight(message(), [
      rule({ pattern: '^@ali', isRegex: true, target: 'user', color: '#f00', sound: false })
    ])
    expect(hit).toEqual({ color: '#f00', flash: true, sound: false, notify: false })
  })

  it('treats an invalid regex as no match (no throw)', () => {
    expect(matchHighlight(message(), [rule({ pattern: '(', isRegex: true })])).toBeUndefined()
  })

  it('honours each alert override, so unticking sound/flash disables that alert', () => {
    expect(
      matchHighlight(message(), [rule({ pattern: 'alice', sound: false, flash: false })])
    ).toMatchObject({ sound: false, flash: false })
    expect(matchHighlight(message(), [rule({ pattern: 'alice', sound: true })])?.sound).toBe(true)
    expect(matchHighlight(message(), [rule({ pattern: 'alice', notify: true })])?.notify).toBe(true)
  })

  it('returns the first matching rule and skips empty patterns and system lines', () => {
    const rules = [rule({ pattern: '' }), rule({ pattern: 'alice', color: '#0f0' })]
    expect(matchHighlight(message(), rules)?.color).toBe('#0f0')
    expect(matchHighlight(message({ system: true }), rules)).toBeUndefined()
  })

  it('messageText joins text and emote codes', () => {
    const m = message({
      fragments: [
        { type: 'text', text: 'gg' },
        {
          type: 'emote',
          code: ':kek:',
          url: 'u',
          provider: '7tv',
          zeroWidth: false,
          animated: false
        }
      ]
    })
    expect(messageText(m)).toBe('gg :kek:')
    expect(matchHighlight(m, [rule({ pattern: ':kek:', target: 'message' })])).toBeDefined()
  })
})
