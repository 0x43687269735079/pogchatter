/**
 * Hosts emote images are served from: Twitch's emote and cheermote CDNs, 7TV, BetterTTV and
 * FrankerFaceZ, and YouTube's image hosts for custom emoji and stickers. The cheermote host is the
 * one Twitch's Get Cheermotes reference shows; FFZ's is from its API's emote URLs
 * (`/v1/set/global`); YouTube's from InnerTube thumbnails (`yt3`/`yt4.ggpht.com`). An image from
 * any other host is not loaded.
 */
export const EMOTE_IMAGE_HOSTS: readonly string[] = [
  'static-cdn.jtvnw.net',
  'd3aqoihi2n8ty8.cloudfront.net',
  'cdn.7tv.app',
  'cdn.betterttv.net',
  'cdn.frankerfacez.com',
  'ggpht.com',
  'ytimg.com'
]

/**
 * True when `url` is an https URL without embedded credentials whose host is one of `hosts` or a
 * subdomain of one. Anything unparsable is refused. Used for images taken from data a third party
 * shaped (a history replay, a log file), where loading an attacker-chosen host would let it track
 * whoever views the row.
 *
 * Args:
 *   url: The candidate image URL.
 *   hosts: Allowed hostnames; a subdomain of an entry is allowed too.
 */
export function isHttpsImageFrom(url: string, hosts: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return false
  }
  return hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
}

/** True when `url` may be loaded as an emote image (see {@link EMOTE_IMAGE_HOSTS}). */
export function isApprovedEmoteUrl(url: string): boolean {
  return isHttpsImageFrom(url, EMOTE_IMAGE_HOSTS)
}
