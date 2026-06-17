import type { Platform } from '@shared/model'

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/

/** Runtime guard for an untrusted platform value (IPC / persisted config). */
export function isPlatform(value: unknown): value is Platform {
  return value === 'twitch' || value === 'youtube'
}

/** Whether a YouTube target/normalized value is an 11-char video id (vs a handle/channel). */
export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value)
}

/** Whether a YouTube target/normalized value is a `UC…` channel id. */
export function isYouTubeChannelId(value: string): boolean {
  return CHANNEL_ID_RE.test(value)
}

/** Extract a `UC…` channel id from a bare id or a youtube.com/channel/ URL (case-sensitive). */
function extractChannelId(raw: string): string | undefined {
  if (CHANNEL_ID_RE.test(raw)) {
    return raw
  }
  const match = raw.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?=[/?#]|$)/)
  return match?.[1]
}

/** Extract an 11-char video id from a bare id or a watch/share/live/shorts URL. */
function extractVideoId(raw: string): string | undefined {
  if (VIDEO_ID_RE.test(raw)) {
    return raw
  }
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match?.[1] !== undefined) {
      return match[1]
    }
  }
  return undefined
}

/** Extract an @handle from a URL or bare input (a plain name with no scheme/path is treated as a handle). */
function extractHandle(raw: string): string | undefined {
  const fromAt = raw.match(/@([A-Za-z0-9._-]+)/)
  if (fromAt?.[1] !== undefined) {
    return fromAt[1]
  }
  if (!raw.includes('/') && !raw.includes('@')) {
    return raw
  }
  return undefined
}

function normalizeTwitchLogin(raw: string): string {
  const value = raw.trim()
  // Pull the login out of a twitch.tv URL (e.g. https://www.twitch.tv/thegameawards/about) so the
  // chat client gets a bare login, not the whole URL — which Twitch rejects as an invalid channel.
  const fromUrl = value.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)
  const login = fromUrl?.[1] ?? value
  return login.replace(/^[#@]/, '').toLowerCase()
}

// A Twitch login is letters/numbers/underscore, at most 25 chars, and can't start with `_`.
const TWITCH_LOGIN_RE = /^[a-z0-9][a-z0-9_]{0,24}$/

/** Whether a target resolves to a valid Twitch login (a bare name, `#name`, `@name`, or twitch.tv URL). */
export function isAcceptableTwitchTarget(raw: string): boolean {
  return TWITCH_LOGIN_RE.test(normalizeTwitchLogin(raw))
}

/**
 * Canonicalize a YouTube target so equivalent inputs map to one source.
 * A watch/live/share URL or bare id → the video id (case-sensitive); a /channel/ URL or bare
 * `UC…` id → the channel id (case-sensitive); a handle or bare channel name → `@handle`
 * lowercased; any other URL (e.g. /c/ or /user/ vanity, unresolvable offline) → trimmed without
 * a trailing `/live`.
 */
function normalizeYouTubeTarget(raw: string): string {
  const target = raw.trim()
  const videoId = extractVideoId(target)
  if (videoId !== undefined) {
    return videoId
  }
  const ucId = extractChannelId(target)
  if (ucId !== undefined) {
    return ucId
  }
  const handle = extractHandle(target)
  if (handle !== undefined) {
    return `@${handle.toLowerCase()}`
  }
  return target.replace(/\/live\/?$/, '').replace(/\/+$/, '')
}

/** The canonical target a source uses internally (Twitch login or YouTube target). */
export function normalizeTarget(platform: Platform, raw: string): string {
  return platform === 'twitch' ? normalizeTwitchLogin(raw) : normalizeYouTubeTarget(raw)
}

/** Deterministic source id; equivalent targets (case, `#`, URL vs id/handle) collapse to one id. */
export function channelId(platform: Platform, target: string): string {
  return `${platform}:${normalizeTarget(platform, target)}`
}

/** Human-readable column label. */
export function channelLabel(platform: Platform, target: string): string {
  const normalized = normalizeTarget(platform, target)
  return platform === 'twitch' ? `#${normalized}` : `yt:${normalized}`
}

const YOUTUBE_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i

/** True if a hostname belongs to YouTube. */
export function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.test(hostname)
}

const YOUTUBE_COOKIE_HOSTS = /(?:^|\.)youtube\.com$/i

/**
 * True if a hostname is a `youtube.com` (sub)domain eligible to receive the pasted browser session
 * cookies — `www.youtube.com` for InnerTube/page reads, `accounts.youtube.com` for cookie rotation.
 * Narrower than {@link isYouTubeHost}: a browser never sends `youtube.com` cookies to `youtu.be` or
 * `youtube-nocookie.com`, so neither may carry (or write back into) the shared session jar.
 */
export function isYouTubeCookieHost(hostname: string): boolean {
  return YOUTUBE_COOKIE_HOSTS.test(hostname)
}

/**
 * Whether a YouTube target is safe to resolve: a handle, bare name, or video id (resolved
 * against youtube.com), or an http(s) URL on a YouTube host. Rejects arbitrary URLs so the
 * main process never fetches a non-YouTube origin while resolving a "channel".
 */
export function isAcceptableYouTubeTarget(raw: string): boolean {
  const target = raw.trim()
  if (!/^https?:\/\//i.test(target)) {
    return true
  }
  try {
    return isYouTubeHost(new URL(target).hostname)
  } catch {
    return false
  }
}
