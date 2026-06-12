/**
 * Pinned desktop-Chrome identity for YouTube requests, to avoid false-positive
 * bot flags for a single human user. Keys the User-Agent off
 * Electron's *real* bundled Chromium major so it's coherent and current — this
 * is the #1 tell to fix (youtubei.js otherwise sends an empty/undici UA).
 *
 * IMPORTANT: we deliberately do NOT inject `Sec-CH-UA*` / `Sec-Fetch-*` headers
 * into InnerTube requests. Testing showed YouTube's `youtubei/v1/{next,player}`
 * POST endpoints reject them from a non-browser context (400), and the research
 * notes a *wrong* Sec-* header is worse than omitting it. The dominant bot
 * signal is IP reputation (residential = the user's own machine), which the UA
 * complements; the Sec-* family is tertiary and breaks requests here.
 */
import { proxiedFetch } from '@main/net/proxy'

export interface BrowserIdentity {
  userAgent: string
  acceptLanguage: string
}

function chromeMajor(): string {
  const version = process.versions['chrome']
  const major = version?.split('.')[0]
  return major !== undefined && /^\d+$/.test(major) ? major : '140'
}

function platformUaOs(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows NT 10.0; Win64; x64'
    case 'linux':
      return 'X11; Linux x86_64'
    default:
      return 'Macintosh; Intel Mac OS X 10_15_7'
  }
}

export function createBrowserIdentity(): BrowserIdentity {
  const major = chromeMajor()
  return {
    userAgent: `Mozilla/5.0 (${platformUaOs()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: 'en-US,en;q=0.9'
  }
}

/**
 * Fetch for plain document GETs (the channel `/live` page) carrying the pinned
 * UA + locale. Safe to add on a GET (unlike the InnerTube POSTs above).
 */
export function createPageFetch(identity: BrowserIdentity): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', identity.userAgent)
    }
    if (!headers.has('Accept-Language')) {
      headers.set('Accept-Language', identity.acceptLanguage)
    }
    // Pass `init` through so a Request input keeps its body/method (only the
    // headers are overridden); fetch merges init over a Request first arg.
    return proxiedFetch(input, { ...init, headers })
  }
}
