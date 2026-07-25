import { describe, expect, it } from 'vitest'
import { splitChatMessage, TWITCH_MESSAGE_LIMIT } from '@shared/splitMessage'

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

  it('keeps every chunk within the limit, including for input built to break it', () => {
    // The invariant is only worth asserting against input that could actually violate it: an
    // unbroken run with no spaces to break on, emoji at both parities against the cut, a giant
    // grapheme cluster ("Zalgo" text is one base character plus hundreds of combining marks), and
    // ordinary prose. Friendly evenly-spaced words alone cannot fail however the loop is written.
    const cases = [
      'word '.repeat(400),
      'a'.repeat(1500),
      '🎉'.repeat(400),
      `x${'🎉'.repeat(400)}`,
      `a${'́'.repeat(700)}`,
      `${'a'.repeat(496)}👨‍👩‍👧‍👦 tail`,
      `${'a'.repeat(10)} ${'b'.repeat(980)}`
    ]
    for (const text of cases) {
      for (const chunk of splitChatMessage(text)) {
        expect(chunk.length, `input: ${text.slice(0, 16)}…`).toBeLessThanOrEqual(
          TWITCH_MESSAGE_LIMIT
        )
      }
    }
  })

  it('breaks a single oversized grapheme cluster rather than letting it through whole', () => {
    // One cluster longer than the whole allowance cannot be kept intact. It must still be broken on
    // code-point boundaries, or twurple's raw-index splitter gets it and tears surrogate pairs.
    const zalgo = `a${'́'.repeat(700)}`
    const chunks = splitChatMessage(zalgo)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TWITCH_MESSAGE_LIMIT)
      expect(chunk).not.toMatch(/[\uD800-\uDFFF]/u)
    }
    expect(chunks.join('')).toBe(zalgo)
  })

  it('does not tear surrogate pairs when it has to break a cluster of emoji modifiers', () => {
    // A long run of skin-tone/ZWJ joined emoji forming one cluster: the fallback split must land
    // between code points, never inside a surrogate pair.
    const cluster = `👍${'\u{1F3FB}'.repeat(300)}`
    for (const chunk of splitChatMessage(cluster)) {
      expect(chunk.length).toBeLessThanOrEqual(TWITCH_MESSAGE_LIMIT)
      expect(chunk).not.toMatch(/[\uD800-\uDFFF]/u)
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
