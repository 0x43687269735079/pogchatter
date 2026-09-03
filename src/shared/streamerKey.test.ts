import { describe, expect, it } from 'vitest'
import { legacyStreamerKey, streamerKeyOf } from '@shared/streamerKey'

describe('streamerKeyOf', () => {
  it('resolves one streamer to one key however the platform names them', () => {
    // The point of the key: a Twitch login, a YouTube channel with its creator name resolved, and
    // the same creator's handle all have to land on the same string, or the same person's donations
    // arrive as three different streamers.
    expect(streamerKeyOf('twitch', 'FallenShadow')).toBe('fallenshadow')
    expect(streamerKeyOf('youtube', 'abc123', 'Fallen Shadow')).toBe('fallenshadow')
    expect(streamerKeyOf('youtube', '@FallenShadow')).toBe('fallenshadow')
  })

  it('falls back to the target when the creator name is empty', () => {
    // A connector that hasn't resolved the creator yet passes '' rather than omitting it; treating
    // that as an identity would key every unresolved YouTube chat to the same empty string.
    expect(streamerKeyOf('youtube', 'abc123', '')).toBe('abc123')
    expect(streamerKeyOf('youtube', '@handle', '   ')).toBe('handle')
  })

  it('strips the punctuation and casing the two platforms disagree about', () => {
    expect(streamerKeyOf('youtube', 'vid', 'Fallen-Shadow!! 🎮')).toBe('fallenshadow')
    // Underscores survive: they are part of a Twitch login, not decoration.
    expect(streamerKeyOf('twitch', 'Some_One')).toBe('some_one')
  })

  it('ignores a creator name on Twitch, where the login is already the identity', () => {
    expect(streamerKeyOf('twitch', 'FallenShadow', 'Someone Else')).toBe('fallenshadow')
  })
})

describe('legacyStreamerKey', () => {
  it('derives the key from an id that names the streamer', () => {
    expect(legacyStreamerKey('twitch:Some_One')).toBe('some_one')
    expect(legacyStreamerKey('youtube:@FallenShadow')).toBe('fallenshadow')
  })

  it('keeps an id that names no streamer opaque', () => {
    // A video id says nothing about who the streamer is. Normalising it would strip the case and
    // punctuation that make it unique, so a pre-key donation keeps its channel id verbatim.
    expect(legacyStreamerKey('youtube:dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ')
    expect(legacyStreamerKey('')).toBe('')
  })
})
