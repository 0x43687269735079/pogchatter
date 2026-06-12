import { describe, expect, it } from 'vitest'
import { channelBaseUrl, liveUrl } from '@main/sources/youtube/urls'

describe('channelBaseUrl', () => {
  it('builds a handle URL from a bare name or @handle', () => {
    expect(channelBaseUrl('lofigirl')).toBe('https://www.youtube.com/@lofigirl')
    expect(channelBaseUrl('@LofiGirl')).toBe('https://www.youtube.com/@LofiGirl')
  })

  it('passes through a YouTube channel URL, trimming trailing slashes', () => {
    expect(channelBaseUrl('https://www.youtube.com/@LofiGirl/')).toBe(
      'https://www.youtube.com/@LofiGirl'
    )
    expect(channelBaseUrl('https://www.youtube.com/channel/UC123')).toBe(
      'https://www.youtube.com/channel/UC123'
    )
  })

  it('builds a /channel/ URL from a bare UC… channel id (the canonical form)', () => {
    expect(channelBaseUrl('UCSJ4gkVC6NrvII8umztf0Ow')).toBe(
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow'
    )
  })

  it('rejects a non-YouTube host and an unparseable URL (SSRF guard)', () => {
    expect(channelBaseUrl('https://evil.com/@foo')).toBeUndefined()
    expect(channelBaseUrl('http://169.254.169.254/latest')).toBeUndefined()
    expect(channelBaseUrl('https://')).toBeUndefined()
  })
})

describe('liveUrl', () => {
  it('appends /live to the channel base URL', () => {
    expect(liveUrl('lofigirl')).toBe('https://www.youtube.com/@lofigirl/live')
    expect(liveUrl('https://www.youtube.com/@LofiGirl')).toBe(
      'https://www.youtube.com/@LofiGirl/live'
    )
    expect(liveUrl('UCSJ4gkVC6NrvII8umztf0Ow')).toBe(
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live'
    )
  })

  it('is undefined when the target resolves to no valid channel URL', () => {
    expect(liveUrl('https://evil.com/@foo')).toBeUndefined()
  })
})
