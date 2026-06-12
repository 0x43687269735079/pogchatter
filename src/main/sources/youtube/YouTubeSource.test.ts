import { describe, expect, it, vi } from 'vitest'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import type { Fragment, SourceStatus } from '@shared/model'
import type { YouTubeAuthManager } from '@main/sources/youtube/YouTubeAuthManager'
import { YouTubeSource } from '@main/sources/youtube/YouTubeSource'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const emotes = {
  ensureChannel: vi.fn(),
  tokenize: (fragments: Fragment[]): Fragment[] => fragments
} as unknown as EmoteEngine

const auth = {
  sendMessage: vi.fn(),
  checkSendRestriction: vi.fn().mockResolvedValue(undefined),
  getEmojiCatalog: vi.fn().mockResolvedValue([])
} as unknown as YouTubeAuthManager

// The signaler starts by default for a live chat; give it a fetch that never resolves so its
// negotiation hangs harmlessly instead of churning while these lifecycle tests run.
const idleFetch = (() => new Promise<never>(() => {})) as unknown as typeof fetch

function liveInfo(continuation = 'c0'): unknown {
  return {
    basic_info: { is_live: true, channel_id: 'UC1' },
    livechat: { continuation, is_replay: false }
  }
}

function emptyChatResponse(continuation = 'c1'): unknown {
  return {
    data: {
      continuationContents: {
        liveChatContinuation: {
          actions: [],
          continuations: [{ timedContinuationData: { continuation, timeoutMs: 5000 } }]
        }
      }
    }
  }
}

describe('YouTubeSource lifecycle cancellation', () => {
  it('does not resolve a video or start a reader if disconnected during reader bootstrap', async () => {
    const reader = deferred<unknown>()
    const getReader = (): Promise<never> => reader.promise as Promise<never>
    const pageFetch = vi.fn()
    const source = new YouTubeSource(
      '@foo',
      getReader,
      pageFetch as unknown as typeof fetch,
      emotes,
      auth
    )
    const statuses: SourceStatus[] = []
    source.on('status', (status) => statuses.push(status))

    const connecting = source.connect()
    await source.disconnect() // bumps the generation while getReader is pending
    reader.resolve({}) // reader resolves, but this connect generation is now stale
    await connecting

    // #open never ran: the /live page fetch was never attempted.
    expect(pageFetch).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toEqual({ state: 'offline' })
  })

  it('uses a normalized, deduplicating source id', () => {
    const getReader = (): Promise<never> => new Promise(() => undefined) as Promise<never>
    const a = new YouTubeSource(
      '@LofiGirl',
      getReader,
      vi.fn() as unknown as typeof fetch,
      emotes,
      auth
    )
    const b = new YouTubeSource(
      'https://www.youtube.com/@lofigirl/live',
      getReader,
      vi.fn() as unknown as typeof fetch,
      emotes,
      auth
    )
    expect(a.id).toBe('youtube:@lofigirl')
    expect(b.id).toBe(a.id)
  })
})

describe('YouTubeSource reader bootstrap retry', () => {
  it('recovers when the initial Innertube creation fails and later succeeds', async () => {
    vi.useFakeTimers()
    try {
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const getReader = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('still offline'))
        .mockResolvedValue(yt)
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        getReader as unknown as () => Promise<never>,
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'error', message: 'Could not reach YouTube' })

      await vi.advanceTimersByTimeAsync(60_000) // retry fails again → stays error, keeps trying
      expect(getReader).toHaveBeenCalledTimes(2)
      expect(source.status()).toEqual({ state: 'error', message: 'Could not reach YouTube' })

      await vi.advanceTimersByTimeAsync(60_000) // retry succeeds → the column comes up
      expect(getReader).toHaveBeenCalledTimes(3)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource post-live handling', () => {
  it('treats a channel target resolving to a post-live replay as ended and finds the next stream', async () => {
    vi.useFakeTimers()
    try {
      const replayInfo = {
        basic_info: { is_live: false, is_live_content: true, channel_id: 'UC1' },
        livechat: { continuation: 'r0', is_replay: true }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValueOnce(replayInfo).mockResolvedValue(liveInfo()),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const pageFetch = vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        text: () => Promise.resolve('')
      })
      const source = new YouTubeSource(
        '@foo',
        () => Promise.resolve(yt as never),
        pageFetch as unknown as typeof fetch,
        emotes,
        auth
      )

      await source.connect()
      // The just-ended stream's replay is never latched onto: no reader, status ENDED.
      expect(source.status()).toEqual({ state: 'ended' })
      expect(yt.actions.execute).not.toHaveBeenCalled()

      // The re-resolve loop keeps running and picks up the channel's next live stream.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps replay behavior for a fixed-video column', async () => {
    const replayInfo = {
      basic_info: { is_live: false, is_post_live_dvr: true, channel_id: 'UC1' },
      livechat: { continuation: 'r0', is_replay: true }
    }
    const yt = {
      getInfo: vi.fn().mockResolvedValue(replayInfo),
      getBasicInfo: vi.fn(),
      actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
    }
    const source = new YouTubeSource(
      'aaaaaaaaaaa',
      () => Promise.resolve(yt as never),
      idleFetch,
      emotes,
      auth
    )

    await source.connect()
    expect(source.status()).toEqual({ state: 'replay' })
    await source.disconnect()
  })
})

describe('YouTubeSource waiting → live transition', () => {
  it('flips to live at the announced start time rather than on the slow poll', async () => {
    vi.useFakeTimers()
    try {
      const scheduledStart = Date.now() + 10_000
      const info = {
        basic_info: {
          is_upcoming: true,
          is_live: false,
          channel_id: 'UC1',
          start_timestamp: new Date(scheduledStart)
        },
        livechat: { continuation: 'c0', is_replay: false }
      }
      const emptyChat = {
        data: {
          continuationContents: {
            liveChatContinuation: {
              actions: [],
              continuations: [{ timedContinuationData: { continuation: 'c1', timeoutMs: 5000 } }]
            }
          }
        }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValue(info),
        getBasicInfo: vi
          .fn()
          .mockResolvedValue({ basic_info: { is_live: true, is_upcoming: false } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChat) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'waiting', scheduledStart })
      expect(yt.getBasicInfo).not.toHaveBeenCalled()

      // The next status poll lands on the announced start time (~10s), not 30s later.
      await vi.advanceTimersByTimeAsync(11_000)
      expect(yt.getBasicInfo).toHaveBeenCalled()
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource chat stall surfacing', () => {
  it('keeps an error while chat polling fails even though video-status polling keeps succeeding', async () => {
    vi.useFakeTimers()
    try {
      const info = {
        basic_info: { is_live: true, channel_id: 'UC1' },
        livechat: { continuation: 'c0', is_replay: false }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValue(info),
        // Video status keeps succeeding (live)…
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        // …while the chat poll keeps failing.
        actions: { execute: vi.fn().mockRejectedValue(new Error('chat endpoint down')) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(120_000)

      // A successful video-status poll must not mask the ongoing chat failure.
      expect(yt.getBasicInfo).toHaveBeenCalled()
      expect(source.status().state).toBe('error')

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource end-of-stream races', () => {
  it('an in-flight status poll cannot resurrect live after the chat ended', async () => {
    vi.useFakeTimers()
    try {
      let chatHealthy = true
      const execute = vi
        .fn()
        .mockImplementation(() => Promise.resolve(chatHealthy ? emptyChatResponse() : { data: {} }))
      const inflight = deferred<unknown>()
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi.fn().mockReturnValueOnce(inflight.promise),
        actions: { execute }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(30_000) // status poll 1 starts and stays in flight
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(1)

      chatHealthy = false // the chat ends: two unreadable responses confirm it
      await vi.advanceTimersByTimeAsync(30_000)
      expect(source.status()).toEqual({ state: 'ended' })

      inflight.resolve({ basic_info: { is_live: true } }) // the stale poll finally lands
      await vi.advanceTimersByTimeAsync(0)
      expect(source.status()).toEqual({ state: 'ended' })

      // …and it must not have restarted the status-poll loop either.
      await vi.advanceTimersByTimeAsync(300_000)
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(1)

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource status-poll end confirmation', () => {
  it('does not end the stream on a single transient not-live status poll', async () => {
    vi.useFakeTimers()
    try {
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi
          .fn()
          .mockResolvedValueOnce({ basic_info: {} }) // transient glitch / parse drift
          .mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(30_000) // the glitch poll — must not end the column
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(30_000) // the next poll says live again
      expect(yt.getBasicInfo.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a live poll between two not-live polls resets the end confirmation', async () => {
    vi.useFakeTimers()
    try {
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi
          .fn()
          .mockResolvedValueOnce({ basic_info: {} }) // miss 1
          .mockResolvedValueOnce({ basic_info: { is_live: true } }) // recovers → reset
          .mockResolvedValueOnce({ basic_info: {} }) // miss 1 again — still not confirmed
          .mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      await vi.advanceTimersByTimeAsync(90_000)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource fixed-video waiting-room recovery', () => {
  it('re-opens a fixed video whose waiting-room chat closed, instead of ending it forever', async () => {
    vi.useFakeTimers()
    try {
      const waitingInfo = {
        basic_info: { is_upcoming: true, is_live: false, channel_id: 'UC1' },
        livechat: { continuation: 'w0', is_replay: false }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValueOnce(waitingInfo).mockResolvedValue(liveInfo()),
        getBasicInfo: vi
          .fn()
          .mockResolvedValue({ basic_info: { is_upcoming: true, is_live: false } }),
        actions: {
          execute: vi
            .fn()
            // The waiting-room chat is closed/recreated: two unreadable 200s end the reader.
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValue(emptyChatResponse())
        }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'waiting' })

      await vi.advanceTimersByTimeAsync(30_000) // the reader confirms the (waiting-room) end
      expect(source.status()).toEqual({ state: 'ended' })

      // …but the stream never started: the low-frequency re-open finds it live and recovers.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(yt.getInfo).toHaveBeenCalledTimes(2)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays terminal for a fixed video that genuinely ended while live', async () => {
    vi.useFakeTimers()
    try {
      let chatHealthy = true
      const execute = vi
        .fn()
        .mockImplementation(() => Promise.resolve(chatHealthy ? emptyChatResponse() : { data: {} }))
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      chatHealthy = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(source.status()).toEqual({ state: 'ended' })

      // No re-resolve: a fixed video that ended live is over for good.
      await vi.advanceTimersByTimeAsync(600_000)
      expect(yt.getInfo).toHaveBeenCalledTimes(1)
      expect(source.status()).toEqual({ state: 'ended' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource imminent-poll decay', () => {
  it('falls back from the 5s cadence to the normal poll once the start is long overdue', async () => {
    vi.useFakeTimers()
    try {
      const scheduledStart = Date.now() + 5_000
      const stillWaiting = {
        basic_info: { is_upcoming: true, is_live: false, start_timestamp: new Date(scheduledStart) }
      }
      const info = {
        basic_info: {
          is_upcoming: true,
          is_live: false,
          channel_id: 'UC1',
          start_timestamp: new Date(scheduledStart)
        },
        livechat: { continuation: 'c0', is_replay: false }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValue(info),
        getBasicInfo: vi.fn().mockResolvedValue(stillWaiting),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      await vi.advanceTimersByTimeAsync(5_000) // poll 1 lands on the announced start
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000) // shortly past the start: imminent cadence
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(700_000) // sail well past the 10-minute grace window
      const settled = yt.getBasicInfo.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000) // the late premiere now polls at 30s, not 5s
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(settled + 2)

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource poisoned continuation recovery', () => {
  it('re-bootstraps the chat with a fresh continuation after sustained poll failures', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockImplementation((_endpoint: string, payload: unknown) => {
        const { continuation } = payload as { continuation: string }
        return continuation === 'c-fresh'
          ? Promise.resolve(emptyChatResponse('c-fresh'))
          : Promise.reject(new Error('400'))
      })
      const yt = {
        getInfo: vi
          .fn()
          .mockResolvedValueOnce(liveInfo('c-poisoned'))
          .mockResolvedValue(liveInfo('c-fresh')),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(40_000) // a few failures in → stalled error surfaced
      expect(source.status()).toEqual({
        state: 'error',
        message: 'Live chat connection lost — retrying'
      })

      // After ~10 consecutive failures the source tears the chat down, re-runs getInfo for a
      // fresh continuation, and the new reader recovers.
      await vi.advanceTimersByTimeAsync(500_000)
      expect(yt.getInfo).toHaveBeenCalledTimes(2)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource re-bootstrap staleness', () => {
  it('a stale in-flight status poll cannot flip the state after an onBroken re-bootstrap', async () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn().mockImplementation((_endpoint: string, payload: unknown) => {
        const { continuation } = payload as { continuation: string }
        return continuation === 'c-fresh'
          ? Promise.resolve(emptyChatResponse('c-fresh'))
          : Promise.reject(new Error('400'))
      })
      const inflight = deferred<unknown>()
      const yt = {
        getInfo: vi
          .fn()
          .mockResolvedValueOnce(liveInfo('c-poisoned'))
          .mockResolvedValue(liveInfo('c-fresh')),
        getBasicInfo: vi
          .fn()
          .mockReturnValueOnce(inflight.promise)
          .mockResolvedValue({ basic_info: { is_live: true } }),
        actions: { execute }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      await vi.advanceTimersByTimeAsync(30_000) // status poll 1 starts and stays in flight
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(1)

      // Sustained chat-poll failures hit BROKEN_THRESHOLD → re-bootstrap onto 'c-fresh'.
      await vi.advanceTimersByTimeAsync(500_000)
      expect(yt.getInfo).toHaveBeenCalledTimes(2)
      expect(source.status()).toEqual({ state: 'live' })

      // The pre-re-bootstrap poll finally lands claiming 'waiting' — it must be stale.
      inflight.resolve({ basic_info: { is_upcoming: true } })
      await vi.advanceTimersByTimeAsync(0)
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource send-restriction probe races', () => {
  it('a stale probe result cannot overwrite a newer one', async () => {
    const first = deferred<string | undefined>()
    const second = deferred<string | undefined>()
    const localAuth = {
      sendMessage: vi.fn(),
      checkSendRestriction: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      getEmojiCatalog: vi.fn().mockResolvedValue([])
    } as unknown as YouTubeAuthManager
    const yt = {
      getInfo: vi.fn().mockResolvedValue(liveInfo()),
      getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
      actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
    }
    const source = new YouTubeSource(
      'aaaaaaaaaaa',
      () => Promise.resolve(yt as never),
      idleFetch,
      emotes,
      localAuth
    )

    await source.connect() // probe 1 (the old identity) is in flight
    source.refreshSendability() // identity switch → probe 2

    second.resolve(undefined) // the new identity may chat
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.resolve('Members-only chat') // the old identity's slow result lands last
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The stale restriction must not leave the composer wrongly read-only.
    expect(source.sendRestriction()).toBeUndefined()

    await source.disconnect()
  })
})

describe('YouTubeSource send gating', () => {
  function authWith(sendMessage: ReturnType<typeof vi.fn>): YouTubeAuthManager {
    return {
      sendMessage,
      checkSendRestriction: vi.fn().mockResolvedValue(undefined),
      getEmojiCatalog: vi.fn().mockResolvedValue([])
    } as unknown as YouTubeAuthManager
  }

  it('rejects sends once the stream has ended even though the video id is still known', async () => {
    vi.useFakeTimers()
    try {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const yt = {
        getInfo: vi.fn().mockResolvedValue(liveInfo()),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: false } }),
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        authWith(sendMessage)
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })
      await source.send('hello')
      expect(sendMessage).toHaveBeenCalledTimes(1)

      // Two consecutive not-live status polls confirm the end (one alone could be a glitch).
      await vi.advanceTimersByTimeAsync(30_000)
      expect(source.status()).toEqual({ state: 'live' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(source.status()).toEqual({ state: 'ended' })
      await expect(source.send('too late')).rejects.toThrow(
        'The stream has ended — no live chat to send to'
      )
      expect(sendMessage).toHaveBeenCalledTimes(1)

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects sends before any video has been resolved', async () => {
    const sendMessage = vi.fn()
    const source = new YouTubeSource(
      '@foo',
      () => new Promise(() => undefined) as Promise<never>,
      idleFetch,
      emotes,
      authWith(sendMessage)
    )
    await expect(source.send('hi')).rejects.toThrow('No live video to send to')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('YouTubeSource status-poll backoff', () => {
  it('backs off the waiting-room cadence while status polls fail and resets on success', async () => {
    vi.useFakeTimers()
    try {
      const scheduledStart = Date.now() + 5_000
      const info = {
        basic_info: {
          is_upcoming: true,
          is_live: false,
          channel_id: 'UC1',
          start_timestamp: new Date(scheduledStart)
        },
        livechat: { continuation: 'c0', is_replay: false }
      }
      const stillWaiting = {
        basic_info: { is_upcoming: true, is_live: false, start_timestamp: new Date(scheduledStart) }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValue(info),
        getBasicInfo: vi
          .fn()
          .mockResolvedValueOnce(stillWaiting) // poll 1 at the announced start
          .mockRejectedValueOnce(new Error('net')) // poll 2 fails → next in 10s
          .mockRejectedValueOnce(new Error('net')) // poll 3 fails → next in 20s
          .mockResolvedValue(stillWaiting), // poll 4 succeeds → back to the 5s cadence
        actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      await vi.advanceTimersByTimeAsync(5_000) // poll 1 lands on the announced start
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000) // imminent cadence → poll 2 (fails)
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000) // 5s of the 10s backoff — no poll yet
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000) // 10s reached → poll 3 (fails)
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(15_000) // 15s of the 20s backoff — still waiting
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(5_000) // 20s reached → poll 4 (succeeds)
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(5_000) // success resets the cadence to imminent
      expect(yt.getBasicInfo).toHaveBeenCalledTimes(5)

      await source.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource degraded-chat surfacing', () => {
  it('stamps degraded onto the live status while the reader reports sustained unknowns', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const textAction = {
        addChatItemAction: {
          item: {
            liveChatTextMessageRenderer: {
              id: 'm1',
              authorName: { simpleText: 'Alice' },
              message: { runs: [{ text: 'hello' }] },
              timestampUsec: '1700000000000000'
            }
          }
        }
      }
      const chat = (actions: unknown[]): unknown => ({
        data: {
          continuationContents: {
            liveChatContinuation: {
              actions,
              continuations: [{ timedContinuationData: { continuation: 'c1', timeoutMs: 5000 } }]
            }
          }
        }
      })
      // One unknown per three actions (~33%) per poll: three in a row trip the reader's detector.
      const unhealthy = chat([{ someNewAction: {} }, textAction, textAction])
      const info = {
        basic_info: { is_live: true, channel_id: 'UC1' },
        livechat: { continuation: 'c0', is_replay: false }
      }
      const yt = {
        getInfo: vi.fn().mockResolvedValue(info),
        getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
        actions: {
          execute: vi
            .fn()
            .mockResolvedValueOnce(unhealthy)
            .mockResolvedValueOnce(unhealthy)
            .mockResolvedValueOnce(unhealthy)
            .mockResolvedValue(chat([textAction]))
        }
      }
      const source = new YouTubeSource(
        'aaaaaaaaaaa',
        () => Promise.resolve(yt as never),
        idleFetch,
        emotes,
        auth
      )

      await source.connect()
      expect(source.status()).toEqual({ state: 'live' })

      await vi.advanceTimersByTimeAsync(0) // poll 1
      await vi.advanceTimersByTimeAsync(2000) // polls 2–3 → reader reports degraded
      expect(source.status()).toEqual({ state: 'live', degraded: true })

      await vi.advanceTimersByTimeAsync(3000) // three clean polls → recovered
      expect(source.status()).toEqual({ state: 'live' })

      await source.disconnect()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('YouTubeSource emoji catalog refresh', () => {
  it('reloads the emoji catalog when sendability is refreshed after a login', async () => {
    const catalog = [{ shortcut: ':hi:', emojiId: 'UC1/abc', url: 'https://e/hi.png' }]
    const localEmotes = {
      ensureChannel: vi.fn(),
      tokenize: (fragments: Fragment[]): Fragment[] => fragments,
      setYouTubeEmojis: vi.fn()
    } as unknown as EmoteEngine
    const localAuth = {
      sendMessage: vi.fn(),
      checkSendRestriction: vi.fn().mockResolvedValue(undefined),
      // Logged out when the chat connects (empty catalog); the post-login refresh sees emojis.
      getEmojiCatalog: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(catalog)
    } as unknown as YouTubeAuthManager
    const yt = {
      getInfo: vi.fn().mockResolvedValue(liveInfo()),
      getBasicInfo: vi.fn().mockResolvedValue({ basic_info: { is_live: true } }),
      actions: { execute: vi.fn().mockResolvedValue(emptyChatResponse()) }
    }
    const source = new YouTubeSource(
      'aaaaaaaaaaa',
      () => Promise.resolve(yt as never),
      idleFetch,
      localEmotes,
      localAuth
    )

    await source.connect()
    expect(localAuth.getEmojiCatalog).toHaveBeenCalledTimes(1)
    expect(localEmotes.setYouTubeEmojis).not.toHaveBeenCalled()

    source.refreshSendability()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(localAuth.getEmojiCatalog).toHaveBeenCalledTimes(2)
    expect(localEmotes.setYouTubeEmojis).toHaveBeenCalledWith('UC1', [
      {
        code: ':hi:',
        provider: 'youtube',
        url: 'https://e/hi.png',
        zeroWidth: false,
        animated: false
      }
    ])

    await source.disconnect()
  })
})

describe('YouTubeSource user profile', () => {
  function sourceWith(yt: unknown): YouTubeSource {
    return new YouTubeSource(
      'aaaaaaaaaaa',
      () => Promise.resolve(yt as never),
      idleFetch,
      emotes,
      auth
    )
  }

  it('builds a profile from the modern PageHeader channel shape', async () => {
    const channel = {
      metadata: {
        title: 'Lofi Girl',
        description: 'beats to relax/study to. '.repeat(20),
        avatar: [{ url: 'https://yt3.example/s88.jpg', width: 88, height: 88 }],
        vanity_channel_url: 'http://www.youtube.com/@LofiGirl'
      },
      header: {
        content: {
          title: { text: { text: 'Lofi Girl' } },
          image: {
            avatar: { image: [{ url: 'https://yt3.example/s160.jpg', width: 160, height: 160 }] }
          },
          metadata: {
            metadata_rows: [
              { metadata_parts: [{ text: { text: '@LofiGirl' } }] },
              {
                metadata_parts: [
                  { text: { text: '15.2M subscribers' } },
                  { text: { text: '441 videos' } }
                ]
              }
            ]
          }
        }
      }
    }
    const yt = { getChannel: vi.fn().mockResolvedValue(channel) }

    const profile = await sourceWith(yt).getUserProfile('UCSJ4gkVC6NrvII8umztf0Ow')

    expect(yt.getChannel).toHaveBeenCalledWith('UCSJ4gkVC6NrvII8umztf0Ow')
    expect(profile).toMatchObject({
      platform: 'youtube',
      userId: 'UCSJ4gkVC6NrvII8umztf0Ow',
      displayName: 'Lofi Girl',
      handle: '@LofiGirl',
      // The largest avatar wins across the metadata + header thumbnail sets.
      avatarUrl: 'https://yt3.example/s160.jpg',
      audience: '15.2M subscribers',
      url: 'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow'
    })
    // The multi-page description is capped (with an ellipsis); the join date is not fetched.
    expect(profile?.description?.length).toBeLessThanOrEqual(300)
    expect(profile?.description?.endsWith('…')).toBe(true)
    expect(profile?.createdAt).toBeUndefined()
  })

  it('builds a profile from the classic C4TabbedHeader shape', async () => {
    const channel = {
      metadata: { title: 'Some Creator' },
      header: {
        author: {
          name: 'Some Creator',
          thumbnails: [{ url: 'https://yt3.example/a.jpg', width: 48, height: 48 }]
        },
        channel_handle: { text: '@somecreator' },
        subscribers: { text: '1.23K subscribers' }
      }
    }
    const yt = { getChannel: vi.fn().mockResolvedValue(channel) }

    const profile = await sourceWith(yt).getUserProfile('UCabc')

    expect(profile).toEqual({
      platform: 'youtube',
      userId: 'UCabc',
      displayName: 'Some Creator',
      handle: '@somecreator',
      avatarUrl: 'https://yt3.example/a.jpg',
      audience: '1.23K subscribers',
      url: 'https://www.youtube.com/channel/UCabc'
    })
  })

  it('returns undefined when the channel fetch or the reader itself fails', async () => {
    const yt = { getChannel: vi.fn().mockRejectedValue(new Error('channel not found')) }
    expect(await sourceWith(yt).getUserProfile('UCabc')).toBeUndefined()

    const noReader = new YouTubeSource(
      'aaaaaaaaaaa',
      () => Promise.reject(new Error('offline')),
      idleFetch,
      emotes,
      auth
    )
    expect(await noReader.getUserProfile('UCabc')).toBeUndefined()
  })

  it('returns undefined when the page carries no usable title', async () => {
    const yt = { getChannel: vi.fn().mockResolvedValue({ metadata: {}, header: {} }) }
    expect(await sourceWith(yt).getUserProfile('UCabc')).toBeUndefined()
  })
})

describe('YouTubeSource channel URL resolution', () => {
  it('fetches the /live page for a /channel URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      text: () => Promise.resolve('')
    })
    const yt = {
      getInfo: vi.fn().mockResolvedValue({
        basic_info: { is_live: true, channel_id: 'UC1' },
        livechat: undefined
      }),
      getBasicInfo: vi.fn(),
      actions: { execute: vi.fn() }
    }
    const source = new YouTubeSource(
      'https://www.youtube.com/channel/UC123abcDEF',
      () => Promise.resolve(yt as never),
      fetchMock as unknown as typeof fetch,
      emotes,
      auth
    )

    await source.connect()
    expect(fetchMock).toHaveBeenCalledWith('https://www.youtube.com/channel/UC123abcDEF/live')

    await source.disconnect()
  })

  it('refuses to fetch a non-YouTube URL target (SSRF guard)', async () => {
    const fetchMock = vi.fn()
    const yt = { getInfo: vi.fn(), getBasicInfo: vi.fn(), actions: { execute: vi.fn() } }
    const source = new YouTubeSource(
      'https://evil.example.com/channel/UC123abc',
      () => Promise.resolve(yt as never),
      fetchMock as unknown as typeof fetch,
      emotes,
      auth
    )

    await source.connect()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(source.status()).toEqual({ state: 'offline' })

    await source.disconnect()
  })
})
