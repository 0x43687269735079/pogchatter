import { describe, expect, it } from 'vitest'
import { legacyStreamerKey, normaliseStreamerKey, streamerKeyOf } from '@shared/streamerKey'

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
    expect(streamerKeyOf('twitch', 'Some_One')).toBe('someone')
  })

  it('ignores a creator name on Twitch, where the login is already the identity', () => {
    expect(streamerKeyOf('twitch', 'FallenShadow', 'Someone Else')).toBe('fallenshadow')
  })
})

describe('legacyStreamerKey', () => {
  it('derives the key from an id that names the streamer', () => {
    expect(legacyStreamerKey('twitch:Some_One')).toBe('someone')
    expect(legacyStreamerKey('youtube:@FallenShadow')).toBe('fallenshadow')
  })

  it('keeps an id that names no streamer opaque', () => {
    // A video id says nothing about who the streamer is. Normalising it would strip the case and
    // punctuation that make it unique, so a pre-key donation keeps its channel id verbatim.
    expect(legacyStreamerKey('youtube:dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ')
    expect(legacyStreamerKey('')).toBe('')
  })
})

describe('streamerKeyOf for names outside the Latin alphabet', () => {
  it('falls back to the creator channel id, never to the per-video target', () => {
    // A Japanese channel name normalises to nothing; the video id would split one creator per room.
    expect(streamerKeyOf('youtube', 'aaaaaaaaaaa', 'こんにちは', 'UCabc_DEF')).toBe('ucabcdef')
    expect(streamerKeyOf('youtube', 'bbbbbbbbbbb', 'こんにちは', 'UCabc_DEF')).toBe('ucabcdef')
  })

  it('still prefers a Latin name over the id', () => {
    expect(streamerKeyOf('youtube', 'aaaaaaaaaaa', 'Fallen Shadow', 'UCabc_DEF')).toBe(
      'fallenshadow'
    )
  })
})

describe('streamerKeyOf across platforms', () => {
  it('matches a Twitch login with underscores to the same name spaced out on YouTube', () => {
    expect(streamerKeyOf('twitch', 'some_streamer')).toBe(
      streamerKeyOf('youtube', 'aaaaaaaaaaa', 'Some Streamer', 'UCabc')
    )
  })
})

describe('normaliseStreamerKey', () => {
  it('brings a stored key with underscores up to date and leaves an opaque id alone', () => {
    expect(normaliseStreamerKey('some_one')).toBe('someone')
    expect(normaliseStreamerKey('someone')).toBe('someone')
    expect(normaliseStreamerKey('youtube:aaaaaaaaaaa')).toBe('youtube:aaaaaaaaaaa')
  })
})

describe('streamerKeyOf for a handle column', () => {
  it('keys a @handle column by the handle, not by whatever the creator calls themselves', () => {
    // The handle is the username a Twitch tab shares; the display name may be anything.
    expect(streamerKeyOf('youtube', '@some_streamer', 'Shondo', 'UCabc')).toBe('somestreamer')
    expect(streamerKeyOf('youtube', '@some_streamer')).toBe('somestreamer')
  })
})

describe('streamerKeyOf for a column opened by video', () => {
  it('keys by the resolved handle over the display name, so it meets the Twitch login', () => {
    expect(
      streamerKeyOf('youtube', 'aaaaaaaaaaa', 'Nitya ch. Phase Connect', 'UCabc', '@Nitya_Nil')
    ).toBe('nityanil')
    expect(streamerKeyOf('youtube', 'aaaaaaaaaaa', 'Nitya ch. Phase Connect', 'UCabc')).toBe(
      'nityachphaseconnect'
    )
  })
})
