import { describe, expect, it } from 'vitest'
import type { Innertube } from 'youtubei.js'
import type { DiscoveredStream } from '@main/sources/youtube/discoverStreams'
import {
  collectLiveAndUpcoming,
  discoverChannelStreams,
  sortForOpening
} from '@main/sources/youtube/discoverStreams'

/** A streams-tab video lockup with the given thumbnail badge. */
function lockup(
  contentId: string,
  title: string,
  badge: { badge_style?: string; text?: string },
  contentType = 'VIDEO'
): unknown {
  return {
    content_type: contentType,
    content_id: contentId,
    metadata: { title: { text: title } },
    content_image: { overlays: [{ badges: [badge] }] }
  }
}

const live = lockup('aaaaaaaaaaa', 'Live now', {
  badge_style: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE',
  text: 'LIVE'
})
const upcoming = lockup('bbbbbbbbbbb', 'Waiting room', {
  badge_style: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT',
  text: 'Upcoming'
})
const vod = lockup('ccccccccccc', 'Past stream', {
  badge_style: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT',
  text: '1:23:45'
})

describe('collectLiveAndUpcoming', () => {
  it('keeps live and upcoming lockups and drops past VODs', () => {
    expect(collectLiveAndUpcoming([live, upcoming, vod])).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'Live now', state: 'live' },
      { videoId: 'bbbbbbbbbbb', title: 'Waiting room', state: 'waiting' }
    ])
  })

  it('falls back to the id when the title is missing', () => {
    const noTitle = {
      content_type: 'VIDEO',
      content_id: 'ddddddddddd',
      content_image: { overlays: [{ badges: [{ text: 'LIVE' }] }] }
    }
    expect(collectLiveAndUpcoming([noTitle])).toEqual([
      { videoId: 'ddddddddddd', title: 'ddddddddddd', state: 'live' }
    ])
  })

  it('ignores non-video lockups, bad ids, and items with no live/upcoming badge', () => {
    const playlist = lockup('eeeeeeeeeee', 'A playlist', { text: 'LIVE' }, 'PLAYLIST')
    const badId = lockup('short', 'x', { text: 'LIVE' })
    const noBadge = lockup('fffffffffff', 'no badge', {})
    expect(collectLiveAndUpcoming([playlist, badId, noBadge, null])).toEqual([])
  })
})

/** A minimal Innertube stand-in exercising resolve → getChannel → getLiveStreams (memo of lockups). */
function fakeReader(over: {
  browseId?: unknown
  hasStreams?: boolean
  lockups?: readonly unknown[]
  getBasicInfoCalls?: string[]
  basicInfo?: (videoId: string) => Promise<{ basic_info: { start_timestamp?: Date } }>
}): Innertube {
  return {
    resolveURL: () => Promise.resolve({ payload: { browseId: over.browseId } }),
    getChannel: () =>
      Promise.resolve({
        has_live_streams: over.hasStreams ?? true,
        getLiveStreams: () =>
          Promise.resolve({ memo: new Map([['LockupView', over.lockups ?? []]]) })
      }),
    getBasicInfo: (videoId: string) => {
      over.getBasicInfoCalls?.push(videoId)
      return over.basicInfo?.(videoId) ?? Promise.resolve({ basic_info: {} })
    }
  } as unknown as Innertube
}

describe('discoverChannelStreams', () => {
  it('resolves a handle and returns its live + upcoming streams', async () => {
    const reader = fakeReader({ browseId: 'UC123', lockups: [live, upcoming, vod] })
    const streams = await discoverChannelStreams(reader, '@lofigirl')
    expect(streams.map((s) => s.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('returns [] for a non-YouTube target without touching the reader', async () => {
    const streams = await discoverChannelStreams(fakeReader({}), 'https://evil.com/@foo')
    expect(streams).toEqual([])
  })

  it('returns [] when the channel has no streams tab (a genuine zero-streams result)', async () => {
    const reader = fakeReader({ browseId: 'UC123', hasStreams: false })
    expect(await discoverChannelStreams(reader, '@lofigirl')).toEqual([])
  })

  it('throws when the URL does not resolve to a channel (parse drift / bad target)', async () => {
    const reader = fakeReader({ browseId: undefined })
    await expect(discoverChannelStreams(reader, '@lofigirl')).rejects.toThrow(
      'YouTube did not resolve "@lofigirl" to a channel'
    )
  })

  it('propagates a resolve failure instead of reporting no streams', async () => {
    const reader = {
      resolveURL: () => Promise.reject(new Error('network down'))
    } as unknown as Innertube
    await expect(discoverChannelStreams(reader, '@lofigirl')).rejects.toThrow('network down')
  })

  it('propagates a channel or Live-tab fetch failure instead of reporting no streams', async () => {
    const reader = {
      resolveURL: () => Promise.resolve({ payload: { browseId: 'UC123' } }),
      getChannel: () => Promise.reject(new Error('429 rate limited'))
    } as unknown as Innertube
    await expect(discoverChannelStreams(reader, '@lofigirl')).rejects.toThrow('429 rate limited')
  })

  it('resolves scheduledStart for waiting entries via getBasicInfo', async () => {
    const start = new Date('2026-09-10T18:00:00Z')
    const reader = fakeReader({
      browseId: 'UC123',
      lockups: [live, upcoming],
      basicInfo: (videoId) =>
        videoId === 'bbbbbbbbbbb'
          ? Promise.resolve({ basic_info: { start_timestamp: start } })
          : Promise.resolve({ basic_info: {} })
    })
    const streams = await discoverChannelStreams(reader, '@lofigirl')
    expect(streams).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'Live now', state: 'live' },
      {
        videoId: 'bbbbbbbbbbb',
        title: 'Waiting room',
        state: 'waiting',
        scheduledStart: start.getTime()
      }
    ])
  })

  it('leaves scheduledStart unset when a getBasicInfo lookup rejects, without failing the others', async () => {
    const failing = lockup('ccccccccccd', 'Waiting, unknown time', { text: 'Upcoming' })
    const start = new Date('2026-09-10T18:00:00Z')
    const reader = fakeReader({
      browseId: 'UC123',
      lockups: [upcoming, failing],
      basicInfo: (videoId) =>
        videoId === 'bbbbbbbbbbb'
          ? Promise.resolve({ basic_info: { start_timestamp: start } })
          : Promise.reject(new Error('boom'))
    })
    const streams = await discoverChannelStreams(reader, '@lofigirl')
    expect(streams).toEqual([
      {
        videoId: 'bbbbbbbbbbb',
        title: 'Waiting room',
        state: 'waiting',
        scheduledStart: start.getTime()
      },
      { videoId: 'ccccccccccd', title: 'Waiting, unknown time', state: 'waiting' }
    ])
  })

  it('calls getBasicInfo only for waiting entries, never for live ones', async () => {
    const calls: string[] = []
    const reader = fakeReader({
      browseId: 'UC123',
      lockups: [live, upcoming],
      getBasicInfoCalls: calls
    })
    await discoverChannelStreams(reader, '@lofigirl')
    expect(calls).toEqual(['bbbbbbbbbbb'])
  })
})

describe('sortForOpening', () => {
  const liveEntry: DiscoveredStream = { videoId: 'aaaaaaaaaaa', title: 'Live', state: 'live' }
  const waiting2000: DiscoveredStream = {
    videoId: 'ccccccccccc',
    title: '8pm start',
    state: 'waiting',
    scheduledStart: new Date('2026-09-10T20:00:00Z').getTime()
  }
  const waiting1800: DiscoveredStream = {
    videoId: 'bbbbbbbbbbb',
    title: '6pm start',
    state: 'waiting',
    scheduledStart: new Date('2026-09-10T18:00:00Z').getTime()
  }
  const waitingNone: DiscoveredStream = {
    videoId: 'ddddddddddd',
    title: 'No known start',
    state: 'waiting'
  }

  it('orders live first, then scheduled waiting entries soonest-first, then unscheduled ones', () => {
    const sorted = sortForOpening([waiting2000, liveEntry, waiting1800, waitingNone])
    expect(sorted.map((s) => s.videoId)).toEqual([
      liveEntry.videoId,
      waiting1800.videoId,
      waiting2000.videoId,
      waitingNone.videoId
    ])
  })

  it('keeps live entries in their discovery order', () => {
    const liveA: DiscoveredStream = { videoId: 'eeeeeeeeeee', title: 'A', state: 'live' }
    const liveB: DiscoveredStream = { videoId: 'fffffffffff', title: 'B', state: 'live' }
    const sorted = sortForOpening([liveB, liveA])
    expect(sorted.map((s) => s.videoId)).toEqual(['fffffffffff', 'eeeeeeeeeee'])
  })

  it('returns a new array without mutating the input', () => {
    const input = [waiting2000, liveEntry]
    const sorted = sortForOpening(input)
    expect(sorted).not.toBe(input)
    expect(input.map((s) => s.videoId)).toEqual(['ccccccccccc', 'aaaaaaaaaaa'])
  })
})
