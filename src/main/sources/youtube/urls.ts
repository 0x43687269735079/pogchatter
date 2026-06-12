import { isYouTubeChannelId, isYouTubeHost } from '@main/sources/channelId'

/**
 * The canonical channel URL for a YouTube target — an `@handle`, a bare name, a `UC…` channel
 * id, or a channel/custom/user URL. A URL is accepted only on a YouTube host so the main process
 * never fetches or resolves an arbitrary user-supplied origin (SSRF); a bare name/handle becomes
 * `https://www.youtube.com/@name`. Returns undefined for a non-YouTube or unparseable URL.
 */
export function channelBaseUrl(target: string): string | undefined {
  if (target.startsWith('http')) {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return undefined
    }
    if (!isYouTubeHost(parsed.hostname)) {
      return undefined
    }
    return target.replace(/\/+$/, '')
  }
  if (isYouTubeChannelId(target)) {
    return `https://www.youtube.com/channel/${target}`
  }
  const handle = target.startsWith('@') ? target : `@${target}`
  return `https://www.youtube.com/${handle}`
}

/** The `/live` page URL for a target; its redirect lands on the channel's current live stream. */
export function liveUrl(target: string): string | undefined {
  const base = channelBaseUrl(target)
  return base === undefined ? undefined : `${base}/live`
}
