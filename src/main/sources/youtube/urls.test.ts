import { describe, expect, it } from 'vitest'
import { channelBaseUrl, liveUrl } from '@main/sources/youtube/urls'

describe('channelBaseUrl', () => {
  it('builds a handle URL from a bare name or @handle', () => {
    expect(channelBaseUrl('pixelgardener')).toBe('https://www.youtube.com/@pixelgardener')
    expect(channelBaseUrl('@PixelGardener')).toBe('https://www.youtube.com/@PixelGardener')
  })

  it('passes through a YouTube channel URL, trimming trailing slashes', () => {
    expect(channelBaseUrl('https://www.youtube.com/@PixelGardener/')).toBe(
      'https://www.youtube.com/@PixelGardener'
    )
    expect(channelBaseUrl('https://www.youtube.com/channel/UC123')).toBe(
      'https://www.youtube.com/channel/UC123'
    )
  })

  it('builds a /channel/ URL from a bare UC… channel id (the canonical form)', () => {
    expect(channelBaseUrl('UCaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa'
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
    expect(liveUrl('pixelgardener')).toBe('https://www.youtube.com/@pixelgardener/live')
    expect(liveUrl('https://www.youtube.com/@PixelGardener')).toBe(
      'https://www.youtube.com/@PixelGardener/live'
    )
    expect(liveUrl('UCaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/live'
    )
  })

  it('is undefined when the target resolves to no valid channel URL', () => {
    expect(liveUrl('https://evil.com/@foo')).toBeUndefined()
  })
})
