import { describe, expect, it } from 'vitest'
import { isApprovedEmoteUrl, isHttpsImageFrom } from '@main/net/imageUrl'

describe('isHttpsImageFrom', () => {
  it('accepts the host itself and its subdomains over https', () => {
    expect(isHttpsImageFrom('https://giphy.com/a.gif', ['giphy.com'])).toBe(true)
    expect(isHttpsImageFrom('https://media2.giphy.com/a.gif', ['giphy.com'])).toBe(true)
  })

  it('refuses a lookalike host that only ends with the name', () => {
    expect(isHttpsImageFrom('https://evilgiphy.com/a.gif', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('https://giphy.com.evil.example/a.gif', ['giphy.com'])).toBe(false)
  })

  it('refuses other schemes', () => {
    expect(isHttpsImageFrom('http://giphy.com/a.gif', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('file:///etc/passwd', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('javascript:alert(1)', ['giphy.com'])).toBe(false)
  })

  it('refuses credentials embedded in the URL', () => {
    expect(isHttpsImageFrom('https://user:pass@giphy.com/a.gif', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('https://token@media1.giphy.com/a.gif', ['giphy.com'])).toBe(false)
  })

  it('refuses anything that does not parse, and an empty host list', () => {
    expect(isHttpsImageFrom('', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('not a url', ['giphy.com'])).toBe(false)
    expect(isHttpsImageFrom('https://giphy.com/a.gif', [])).toBe(false)
  })
})

describe('isApprovedEmoteUrl', () => {
  it('accepts every emote CDN the app loads from', () => {
    for (const url of [
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
      // The image URL shape in Twitch's Get Cheermotes reference.
      'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/1/1.gif',
      'https://cdn.7tv.app/emote/01ABCDEFGHJKMNPQRSTVWXYZ00/1x.webp',
      'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/1x',
      'https://cdn.frankerfacez.com/emote/1234/1',
      'https://yt3.ggpht.com/abcDEF123=w24-h24-c-k-nd',
      'https://i.ytimg.com/vi/abcdefghijk/default.jpg'
    ]) {
      expect(isApprovedEmoteUrl(url)).toBe(true)
    }
  })

  it('refuses an image host outside the list', () => {
    expect(isApprovedEmoteUrl('https://tracker.example/pixel.gif')).toBe(false)
  })

  it('allows only Twitch’s cheermote distribution, not CloudFront at large', () => {
    expect(isApprovedEmoteUrl('https://anyone.cloudfront.net/pixel.gif')).toBe(false)
  })
})
