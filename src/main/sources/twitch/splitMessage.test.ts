import { describe, expect, it } from 'vitest'
import { splitChatMessage, TWITCH_MESSAGE_LIMIT } from '@main/sources/twitch/splitMessage'

/** Count of unpaired surrogates — anything above 0 means a character was torn in half. */
function unpairedSurrogates(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
      } else {
        count += 1
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      count += 1
    }
  }
  return count
}

describe('splitChatMessage', () => {
  it('returns a message that already fits unchanged', () => {
    expect(splitChatMessage('hello 🎉')).toEqual(['hello 🎉'])
    const exact = 'a'.repeat(TWITCH_MESSAGE_LIMIT)
    expect(splitChatMessage(exact)).toEqual([exact])
  })

  it('keeps every chunk within the limit', () => {
    for (const chunk of splitChatMessage('word '.repeat(400))) {
      expect(chunk.length).toBeLessThanOrEqual(TWITCH_MESSAGE_LIMIT)
    }
  })

  it('never tears an emoji in half, at any alignment', () => {
    // The original bug: a raw UTF-16 cut lands mid-surrogate-pair for half of all offsets, so the
    // emoji either side of the boundary arrives as `�`. Sweep the offsets that used to break.
    for (let pad = 0; pad < 8; pad += 1) {
      const text = 'x'.repeat(pad) + '🎉'.repeat(400)
      const chunks = splitChatMessage(text)
      const torn = chunks.reduce((total, chunk) => total + unpairedSurrogates(chunk), 0)
      expect(torn, `pad=${pad}`).toBe(0)
    }
  })

  it('keeps a multi-code-point emoji whole rather than splitting its parts', () => {
    // A ZWJ family survives a surrogate-safe cut but is still torn into separate people by one
    // that ignores grapheme clusters.
    const family = '👨‍👩‍👧‍👦'
    const chunks = splitChatMessage('x'.repeat(496) + family + ' tail')
    expect(chunks.some((chunk) => chunk.includes(family))).toBe(true)
  })

  it('preserves the message content across the split', () => {
    const text = `${'word '.repeat(150)}👨‍👩‍👧‍👦 ${'more '.repeat(50)}🎉`
    const chunks = splitChatMessage(text)
    expect(chunks.length).toBeGreaterThan(1)
    // Rejoining with the spaces the split consumed reproduces the original text.
    expect(chunks.join(' ')).toBe(text.trim().replace(/\s+/gu, ' '))
  })

  it('breaks at spaces so words stay whole', () => {
    const chunks = splitChatMessage('word '.repeat(400))
    for (const chunk of chunks) {
      expect(chunk.startsWith('word')).toBe(true)
      expect(chunk.endsWith('word')).toBe(true)
    }
  })

  it('splits an unbroken run with no spaces to fall back on', () => {
    const chunks = splitChatMessage('a'.repeat(1200))
    expect(chunks).toEqual(['a'.repeat(500), 'a'.repeat(500), 'a'.repeat(200)])
  })
})
