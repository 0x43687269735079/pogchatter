import { describe, expect, it } from 'vitest'
import {
  channelId,
  channelLabel,
  isAcceptableTwitchTarget,
  isAcceptableYouTubeTarget,
  isPlatform,
  isYouTubeChannelId,
  isYouTubeHost,
  normalizeTarget
} from '@main/sources/channelId'

describe('isPlatform', () => {
  it('accepts known platforms and rejects everything else', () => {
    expect(isPlatform('twitch')).toBe(true)
    expect(isPlatform('youtube')).toBe(true)
    expect(isPlatform('kick')).toBe(false)
    expect(isPlatform(undefined)).toBe(false)
    expect(isPlatform(42)).toBe(false)
  })
})

describe('Twitch normalization', () => {
  it('lowercases and strips a leading # and whitespace', () => {
    expect(channelId('twitch', '#SomeStreamer')).toBe('twitch:somestreamer')
    expect(channelId('twitch', 'somestreamer')).toBe('twitch:somestreamer')
    expect(channelId('twitch', '  Somestreamer ')).toBe('twitch:somestreamer')
    expect(normalizeTarget('twitch', '#Foo')).toBe('foo')
  })

  it('extracts the login from a twitch.tv URL', () => {
    expect(normalizeTarget('twitch', 'https://www.twitch.tv/thegameawards')).toBe('thegameawards')
    expect(normalizeTarget('twitch', 'https://twitch.tv/TheGameAwards/about')).toBe('thegameawards')
    expect(channelId('twitch', 'https://www.twitch.tv/TheGameAwards')).toBe('twitch:thegameawards')
    expect(channelLabel('twitch', 'https://www.twitch.tv/thegameawards')).toBe('#thegameawards')
  })

  it('validates targets: a bare name, @name, or twitch.tv URL, but not arbitrary input', () => {
    expect(isAcceptableTwitchTarget('thegameawards')).toBe(true)
    expect(isAcceptableTwitchTarget('@TheGameAwards')).toBe(true)
    expect(isAcceptableTwitchTarget('https://www.twitch.tv/thegameawards')).toBe(true)
    expect(isAcceptableTwitchTarget('https://example.com/foo')).toBe(false)
    expect(isAcceptableTwitchTarget('foo bar')).toBe(false)
    expect(isAcceptableTwitchTarget('_leadingunderscore')).toBe(false)
    expect(isAcceptableTwitchTarget('waytoolongtobeavalidtwitchlogin')).toBe(false)
  })
})

describe('YouTube dedup', () => {
  it('collapses a handle regardless of case, leading @, or surrounding URL', () => {
    const id = 'youtube:@lofigirl'
    expect(channelId('youtube', '@LofiGirl')).toBe(id)
    expect(channelId('youtube', 'lofigirl')).toBe(id)
    expect(channelId('youtube', 'https://www.youtube.com/@LofiGirl/live')).toBe(id)
    expect(channelId('youtube', 'https://www.youtube.com/@lofigirl')).toBe(id)
  })

  it('reduces watch / share / live URLs and bare ids to the video id', () => {
    const id = 'youtube:dQw4w9WgXcQ'
    expect(channelId('youtube', 'dQw4w9WgXcQ')).toBe(id)
    expect(channelId('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(id)
    expect(channelId('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe(id)
    expect(channelId('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toBe(id)
    expect(channelId('youtube', 'https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(id)
  })

  it('preserves case for video ids (they are case-sensitive)', () => {
    expect(channelId('youtube', 'AbCdEfGhIjK')).toBe('youtube:AbCdEfGhIjK')
  })
})

describe('YouTube channel URLs', () => {
  const UC = 'UCSJ4gkVC6NrvII8umztf0Ow' // standard 24-char channel id

  it('collapses a /channel/UC… URL and a bare UC… id to the channel id, preserving case', () => {
    expect(channelId('youtube', `https://www.youtube.com/channel/${UC}`)).toBe(`youtube:${UC}`)
    expect(channelId('youtube', `https://www.youtube.com/channel/${UC}/`)).toBe(`youtube:${UC}`)
    expect(channelId('youtube', `https://www.youtube.com/channel/${UC}/live`)).toBe(`youtube:${UC}`)
    expect(channelId('youtube', UC)).toBe(`youtube:${UC}`)
    expect(isYouTubeChannelId(UC)).toBe(true)
    expect(isYouTubeChannelId('@lofigirl')).toBe(false)
  })

  it('keeps a /channel/ URL with a non-standard id as a trimmed URL', () => {
    expect(channelId('youtube', 'https://www.youtube.com/channel/UCabcDEF12345')).toBe(
      'youtube:https://www.youtube.com/channel/UCabcDEF12345'
    )
  })

  it('keeps /c and /user vanity URLs as trimmed URLs (not resolvable offline)', () => {
    expect(channelId('youtube', 'https://www.youtube.com/c/SomeName/')).toBe(
      'youtube:https://www.youtube.com/c/SomeName'
    )
    expect(channelId('youtube', 'https://www.youtube.com/user/SomeUser/live')).toBe(
      'youtube:https://www.youtube.com/user/SomeUser'
    )
  })
})

describe('YouTube target host validation', () => {
  it('recognizes YouTube hosts and rejects others', () => {
    expect(isYouTubeHost('youtube.com')).toBe(true)
    expect(isYouTubeHost('www.youtube.com')).toBe(true)
    expect(isYouTubeHost('youtu.be')).toBe(true)
    expect(isYouTubeHost('www.youtube-nocookie.com')).toBe(true)
    expect(isYouTubeHost('evil.com')).toBe(false)
    expect(isYouTubeHost('notyoutube.com')).toBe(false)
    expect(isYouTubeHost('youtube.com.evil.com')).toBe(false)
  })

  it('accepts handles, ids, and YouTube URLs but rejects arbitrary URLs', () => {
    expect(isAcceptableYouTubeTarget('@LofiGirl')).toBe(true)
    expect(isAcceptableYouTubeTarget('LofiGirl')).toBe(true)
    expect(isAcceptableYouTubeTarget('dQw4w9WgXcQ')).toBe(true)
    expect(isAcceptableYouTubeTarget('https://www.youtube.com/channel/UC123')).toBe(true)
    expect(isAcceptableYouTubeTarget('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isAcceptableYouTubeTarget('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isAcceptableYouTubeTarget('https://evil.com/@foo')).toBe(false)
  })
})

describe('channelLabel', () => {
  it('formats per platform from the normalized target', () => {
    expect(channelLabel('twitch', '#Foo')).toBe('#foo')
    expect(channelLabel('youtube', '@Foo')).toBe('yt:@foo')
    expect(channelLabel('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ')
  })
})
