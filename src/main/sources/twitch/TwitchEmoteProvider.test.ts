import { describe, expect, it } from 'vitest'
import { emoteFromHelix } from '@main/sources/twitch/TwitchEmoteProvider'

const TEMPLATE =
  'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}'

describe('emoteFromHelix', () => {
  it('builds a static dark 2x URL', () => {
    const emote = emoteFromHelix(
      {
        id: 'emotesv2_abc',
        name: 'Kappa',
        format: ['static'],
        scale: ['1.0', '2.0', '3.0'],
        theme_mode: ['light', 'dark']
      },
      TEMPLATE
    )
    expect(emote).toEqual({
      code: 'Kappa',
      provider: 'twitch',
      url: 'https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/static/dark/2.0',
      zeroWidth: false,
      animated: false
    })
  })

  it('prefers the animated format and flags it', () => {
    const emote = emoteFromHelix(
      {
        id: 'x',
        name: 'pphop',
        format: ['static', 'animated'],
        scale: ['1.0'],
        theme_mode: ['light']
      },
      TEMPLATE
    )
    expect(emote.url).toBe('https://static-cdn.jtvnw.net/emoticons/v2/x/animated/light/1.0')
    expect(emote.animated).toBe(true)
  })
})
