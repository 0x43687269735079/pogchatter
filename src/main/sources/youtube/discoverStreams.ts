import type { Innertube } from 'youtubei.js'
import { channelBaseUrl } from '@main/sources/youtube/urls'

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Maximum concurrent `getBasicInfo` lookups when resolving waiting entries' scheduled starts. */
const SCHEDULED_START_LOOKUP_CONCURRENCY = 4

/** A live or waiting-room (scheduled/upcoming) stream discovered on a channel's Live tab. */
export interface DiscoveredStream {
  videoId: string
  title: string
  state: 'live' | 'waiting'
  scheduledStart?: number
}

/**
 * List a YouTube channel's live and waiting-room streams by reading its "Live" tab. The tab is built
 * from `lockupViewModel` nodes (youtubei.js's `.videos` getter doesn't surface them), where a
 * thumbnail badge marks each item as LIVE, Upcoming, or a past VOD (a duration) — we keep the first
 * two. For each waiting entry, best-effort resolves a `scheduledStart` via `reader.getBasicInfo`
 * (see {@link resolveScheduledStarts}); the returned array is in discovery order, unsorted — call
 * {@link sortForOpening} to order it. Returns [] only when the channel genuinely has nothing to add
 * (non-YouTube target, no streams tab); a network/parse failure of the channel/tab itself throws so
 * the caller can surface it instead of reporting a successful no-op.
 */
export async function discoverChannelStreams(
  reader: Innertube,
  target: string
): Promise<DiscoveredStream[]> {
  const url = channelBaseUrl(target)
  if (url === undefined) {
    return []
  }
  const endpoint = await reader.resolveURL(url)
  const browseId = endpoint.payload?.browseId
  if (typeof browseId !== 'string') {
    throw new Error(`YouTube did not resolve "${target}" to a channel`)
  }
  const channel = await reader.getChannel(browseId)
  if (!channel.has_live_streams) {
    return []
  }
  const streams = await channel.getLiveStreams()
  const discovered = collectLiveAndUpcoming(lockupsOf(streams))
  await resolveScheduledStarts(reader, discovered)
  return discovered
}

/**
 * Orders discovered streams for opening: live streams first (in discovery order), then waiting
 * streams with a known `scheduledStart` soonest-first, then waiting streams with no known start
 * (in discovery order). Pure — returns a new array, leaving `streams` untouched.
 */
export function sortForOpening(streams: DiscoveredStream[]): DiscoveredStream[] {
  const live = streams.filter((stream) => stream.state === 'live')
  const scheduled = streams.filter(
    (stream) => stream.state === 'waiting' && stream.scheduledStart !== undefined
  )
  const unscheduled = streams.filter(
    (stream) => stream.state === 'waiting' && stream.scheduledStart === undefined
  )
  scheduled.sort((a, b) => (a.scheduledStart ?? 0) - (b.scheduledStart ?? 0))
  return [...live, ...scheduled, ...unscheduled]
}

/**
 * Best-effort resolution of `scheduledStart` for each `waiting` entry, mutating the entries in
 * place. Looks up at most `SCHEDULED_START_LOOKUP_CONCURRENCY` videos at once via
 * `reader.getBasicInfo`; a lookup that fails simply leaves that entry without a `scheduledStart`
 * rather than failing the whole discovery.
 */
async function resolveScheduledStarts(
  reader: Innertube,
  streams: DiscoveredStream[]
): Promise<void> {
  const waiting = streams.filter((stream) => stream.state === 'waiting')
  await runWithConcurrencyLimit(waiting, SCHEDULED_START_LOOKUP_CONCURRENCY, async (stream) => {
    const start = await lookupScheduledStart(reader, stream.videoId)
    if (start !== undefined) {
      stream.scheduledStart = start
    }
  })
}

/** Resolves a single video's scheduled start time, or `undefined` if the lookup fails. */
async function lookupScheduledStart(
  reader: Innertube,
  videoId: string
): Promise<number | undefined> {
  try {
    const info = await reader.getBasicInfo(videoId)
    return info.basic_info.start_timestamp?.getTime()
  } catch {
    return undefined
  }
}

/** Runs `task` over `items` with at most `limit` calls in flight at once. */
async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) {
        return
      }
      const item = items[index] as T
      await task(item)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
}

/** The Live tab's video lockups, read from the feed's parse memo (keyed by node type name). */
function lockupsOf(feed: unknown): readonly unknown[] {
  const memo = (feed as { memo?: { get(type: string): unknown[] | undefined } }).memo
  return memo?.get('LockupView') ?? []
}

/** Keep only the live/upcoming video lockups; node shapes vary, so read each defensively. */
export function collectLiveAndUpcoming(lockups: readonly unknown[]): DiscoveredStream[] {
  const streams: DiscoveredStream[] = []
  for (const lockup of lockups) {
    const stream = readLockup(lockup)
    if (stream !== undefined) {
      streams.push(stream)
    }
  }
  return streams
}

function readLockup(item: unknown): DiscoveredStream | undefined {
  if (!isObject(item) || item['content_type'] !== 'VIDEO') {
    return undefined
  }
  const videoId = item['content_id']
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    return undefined
  }
  const state = streamState(item)
  if (state === undefined) {
    return undefined
  }
  return { videoId, title: lockupTitle(item) ?? videoId, state }
}

/** A lockup is live/upcoming per its thumbnail badge; a duration badge means a past VOD (skip). */
function streamState(node: Record<string, unknown>): 'live' | 'waiting' | undefined {
  for (const badge of badgesOf(node)) {
    const style = typeof badge['badge_style'] === 'string' ? badge['badge_style'] : ''
    const text = typeof badge['text'] === 'string' ? badge['text'] : ''
    if (style === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' || text.toUpperCase() === 'LIVE') {
      return 'live'
    }
    if (text.toLowerCase() === 'upcoming') {
      return 'waiting'
    }
  }
  return undefined
}

function badgesOf(node: Record<string, unknown>): Record<string, unknown>[] {
  const image = node['content_image']
  const overlays = isObject(image) ? image['overlays'] : undefined
  if (!Array.isArray(overlays)) {
    return []
  }
  const badges: Record<string, unknown>[] = []
  for (const overlay of overlays) {
    if (isObject(overlay) && Array.isArray(overlay['badges'])) {
      for (const badge of overlay['badges']) {
        if (isObject(badge)) {
          badges.push(badge)
        }
      }
    }
  }
  return badges
}

/** A lockup title is a `{ text }` node (or, defensively, a plain string). */
function lockupTitle(node: Record<string, unknown>): string | undefined {
  const metadata = node['metadata']
  const title = isObject(metadata) ? metadata['title'] : undefined
  if (typeof title === 'string') {
    return title
  }
  if (isObject(title) && typeof title['text'] === 'string') {
    return title['text']
  }
  return undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
