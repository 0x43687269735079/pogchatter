import { describe, expect, it } from 'vitest'
import type { ChatMessage, Fragment } from '@shared/model'
import { retokenizeAgainst } from '@main/retokenize'

function message(id: string, fragments: Fragment[]): ChatMessage {
  return {
    id,
    platform: 'twitch',
    channelId: 'twitch:pixelgardener',
    timestamp: 1_700_000_000_000,
    author: {
      id: 'u-42',
      name: 'mossflower',
      displayName: 'Mossflower',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments
  }
}

/**
 * Stands in for the emote engine's tokenizer: swaps any whitespace-delimited word matching `code`
 * for an emote and re-joins the rest into text runs, leaving `verbatim` and non-text fragments as
 * they are — so text with no known emote in it comes back byte-identical.
 */
function tokenizerFor(code: string): (fragments: Fragment[]) => Fragment[] {
  return (fragments) => {
    const out: Fragment[] = []
    for (const fragment of fragments) {
      if (fragment.type !== 'text' || fragment.verbatim === true) {
        out.push(fragment)
        continue
      }
      let buffer = ''
      for (const piece of fragment.text.split(/(\s+)/)) {
        if (piece !== code) {
          buffer += piece
          continue
        }
        if (buffer !== '') {
          out.push({ type: 'text', text: buffer })
          buffer = ''
        }
        out.push({
          type: 'emote',
          code,
          url: `https://emotes.example/${code}.webp`,
          provider: '7tv'
        })
      }
      if (buffer !== '') {
        out.push({ type: 'text', text: buffer })
      }
    }
    return out
  }
}

describe('retokenizeAgainst', () => {
  it('turns a now-known emote name into an emote fragment', () => {
    const input = message('m1', [{ type: 'text', text: 'hey catJAM there' }])
    const [changed] = retokenizeAgainst([input], tokenizerFor('catJAM'))
    expect(changed?.fragments).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'emote', code: 'catJAM', url: 'https://emotes.example/catJAM.webp', provider: '7tv' },
      { type: 'text', text: ' there' }
    ])
  })

  it('does not return a message whose fragments come back the same', () => {
    const unchanged = message('m1', [
      { type: 'emote', code: 'catJAM', url: 'https://emotes.example/catJAM.webp', provider: '7tv' }
    ])
    expect(retokenizeAgainst([unchanged], tokenizerFor('catJAM'))).toEqual([])
  })

  it('returns only the changed messages out of a mixed batch', () => {
    const stale = message('m1', [{ type: 'text', text: 'catJAM' }])
    const settled = message('m2', [{ type: 'text', text: 'no emotes here' }])
    const changed = retokenizeAgainst([settled, stale], tokenizerFor('catJAM'))
    expect(changed.map((m) => m.id)).toEqual(['m1'])
  })

  it('leaves a verbatim text fragment untouched', () => {
    const verbatim: Fragment = { type: 'text', text: 'catJAM', verbatim: true }
    const input = message('m1', [verbatim])
    expect(retokenizeAgainst([input], tokenizerFor('catJAM'))).toEqual([])
    expect(input.fragments[0]).toBe(verbatim)
  })

  it('returns a new message object and never mutates the input', () => {
    const fragments: Fragment[] = [{ type: 'text', text: 'catJAM' }]
    const input = message('m1', fragments)
    const [changed] = retokenizeAgainst([input], tokenizerFor('catJAM'))
    expect(changed).not.toBe(input)
    expect(changed?.id).toBe('m1')
    expect(input.fragments).toBe(fragments)
    expect(input.fragments).toEqual([{ type: 'text', text: 'catJAM' }])
  })

  it('returns nothing for an empty input', () => {
    expect(retokenizeAgainst([], tokenizerFor('catJAM'))).toEqual([])
  })
})

describe('retokenizeAgainst and emotes already matched', () => {
  const stale: Fragment = {
    type: 'emote',
    code: 'X',
    url: 'https://emotes.example/global/X.webp',
    provider: '7tv'
  }

  it('revises a third-party emote when a catalogue that outranks the earlier match arrives', () => {
    // A global 7TV emote matched first; the channel's own set, which takes precedence, then loads
    // with an emote of the same name. The row must show the channel's, as new messages do.
    const changed = retokenizeAgainst(
      [message('m1', [{ type: 'text', text: 'hello ' }, stale, { type: 'text', text: ' world' }])],
      tokenizerFor('X')
    )
    expect(changed.map((m) => m.fragments)).toEqual([
      [
        { type: 'text', text: 'hello ' },
        { type: 'emote', code: 'X', url: 'https://emotes.example/X.webp', provider: '7tv' },
        { type: 'text', text: ' world' }
      ]
    ])
  })

  it('reverts a third-party emote a provider no longer serves to its text', () => {
    const changed = retokenizeAgainst([message('m1', [stale])], tokenizerFor('Y'))
    expect(changed.map((m) => m.fragments)).toEqual([[{ type: 'text', text: 'X' }]])
  })

  it('leaves adjacent text runs alone when nothing needs re-tokenising', () => {
    // YouTube keeps one text fragment per run (a link splits the text around it); merging them
    // would make an unchanged message compare unequal and be re-pushed on every catalogue change.
    const runs = message('m1', [
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'https://example.test/x' },
      { type: 'text', text: ' now' }
    ])
    expect(retokenizeAgainst([runs], tokenizerFor('X'))).toEqual([])
  })

  it("leaves a native emote from the platform's own tag as it is", () => {
    // Native emotes are not derived from any catalogue, so a catalogue change cannot revise them.
    const native: Fragment = {
      type: 'emote',
      code: 'X',
      url: 'https://static-cdn.example/X/2.0',
      provider: 'twitch'
    }
    expect(retokenizeAgainst([message('m1', [native])], tokenizerFor('X'))).toEqual([])
  })
})
