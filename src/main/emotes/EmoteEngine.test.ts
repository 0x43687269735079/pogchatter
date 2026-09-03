import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/emotes/providers/sevenTv', () => ({
  fetchSevenTvGlobal: vi.fn().mockResolvedValue({ setId: undefined, emotes: [] }),
  fetchSevenTvChannel: vi.fn().mockResolvedValue({ setId: undefined, emotes: [] })
}))
vi.mock('@main/emotes/providers/bttv', () => ({
  fetchBttvGlobal: vi.fn().mockResolvedValue([]),
  fetchBttvChannel: vi.fn().mockResolvedValue([])
}))
vi.mock('@main/emotes/providers/ffz', () => ({
  fetchFfzGlobal: vi.fn().mockResolvedValue([]),
  fetchFfzChannel: vi.fn().mockResolvedValue([])
}))
vi.mock('@main/debugLog', () => ({ debugLog: vi.fn() }))

import type { EmoteProviderSettings } from '@shared/model'
import { debugLog } from '@main/debugLog'
import { EmoteEngine, type IndexChange } from '@main/emotes/EmoteEngine'
import type { EventsSocket } from '@main/emotes/SevenTvEvents'
import { fetchBttvChannel, fetchBttvGlobal } from '@main/emotes/providers/bttv'
import { fetchFfzChannel, fetchFfzGlobal } from '@main/emotes/providers/ffz'
import { fetchSevenTvChannel, fetchSevenTvGlobal } from '@main/emotes/providers/sevenTv'
import type { ResolvedEmote } from '@main/emotes/types'

function twitchEmote(code: string): ResolvedEmote {
  return { code, provider: 'twitch', url: `http://cdn/${code}`, zeroWidth: false, animated: false }
}

function sevenTvEmote(code: string): ResolvedEmote {
  return { code, provider: '7tv', url: `http://e/${code}`, zeroWidth: false, animated: false }
}

function bttvEmote(code: string): ResolvedEmote {
  return { code, provider: 'bttv', url: `http://b/${code}`, zeroWidth: false, animated: false }
}

/** Let queued microtasks run without letting any timer fire — "did it resolve this tick?". */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('EmoteEngine Twitch emotes', () => {
  it('tokenizes Twitch global emotes in any column (including YouTube)', () => {
    const engine = new EmoteEngine()
    engine.setTwitchGlobal([twitchEmote('Kappa')])

    const out = engine.tokenize([{ type: 'text', text: 'hi Kappa' }], 'youtube', 'UCxyz')

    expect(out).toEqual([
      { type: 'text', text: 'hi ' },
      {
        type: 'emote',
        code: 'Kappa',
        url: 'http://cdn/Kappa',
        provider: 'twitch',
        zeroWidth: false,
        animated: false
      }
    ])
  })

  it('leaves verbatim text fragments untouched even when they match an emote code', () => {
    const engine = new EmoteEngine()
    engine.setTwitchGlobal([twitchEmote('1984')])

    // A cheer's bits amount rides as verbatim text — a numeric emote code must not eat it.
    const out = engine.tokenize(
      [
        { type: 'text', text: '1984', verbatim: true },
        { type: 'text', text: ' 1984' }
      ],
      'twitch',
      '123'
    )

    expect(out[0]).toEqual({ type: 'text', text: '1984', verbatim: true })
    expect(out[2]).toMatchObject({ type: 'emote', code: '1984' })
  })

  it('applies Twitch channel emotes only in that Twitch room', () => {
    const engine = new EmoteEngine()
    engine.setTwitchChannel('123', [twitchEmote('subEmote')])

    const inRoom = engine.tokenize([{ type: 'text', text: 'subEmote' }], 'twitch', '123')
    const otherRoom = engine.tokenize([{ type: 'text', text: 'subEmote' }], 'twitch', '999')

    expect(inRoom[0]).toMatchObject({ type: 'emote', code: 'subEmote' })
    expect(otherRoom).toEqual([{ type: 'text', text: 'subEmote' }])
  })

  it('lists Twitch global emotes as global in every scope, channel ones only for that room', () => {
    const engine = new EmoteEngine()
    engine.setTwitchGlobal([twitchEmote('Kappa')])
    engine.setTwitchChannel('123', [twitchEmote('subEmote')])

    const twitchScope = engine.list({ platform: 'twitch', channelId: '123' })
    expect(twitchScope).toContainEqual(
      expect.objectContaining({ code: 'subEmote', scope: 'channel' })
    )
    expect(twitchScope).toContainEqual(expect.objectContaining({ code: 'Kappa', scope: 'global' }))

    const youtubeScope = engine.list({ platform: 'youtube', channelId: 'UCxyz' })
    expect(youtubeScope.map((e) => e.code)).toContain('Kappa')
    expect(youtubeScope.map((e) => e.code)).not.toContain('subEmote')
  })

  it('clearTwitch drops the Twitch catalog', () => {
    const engine = new EmoteEngine()
    engine.setTwitchGlobal([twitchEmote('Kappa')])
    engine.clearTwitch()

    expect(engine.tokenize([{ type: 'text', text: 'Kappa' }], 'twitch', '1')).toEqual([
      { type: 'text', text: 'Kappa' }
    ])
  })
})

describe('EmoteEngine shared library', () => {
  it("renders the account's own 7TV emotes in every column, tagged library", async () => {
    vi.mocked(fetchSevenTvChannel).mockResolvedValueOnce({
      setId: undefined,
      emotes: [sevenTvEmote('glorpass')]
    })
    const engine = new EmoteEngine()
    await engine.loadUserEmotes('twitch', '578762718')

    // Used as text in a YouTube chat — still tokenized (shared pool applies everywhere).
    const out = engine.tokenize([{ type: 'text', text: 'gg glorpass' }], 'youtube', 'UCxyz')
    expect(out).toContainEqual(expect.objectContaining({ type: 'emote', code: 'glorpass' }))

    // And it shows in the picker for any column under the library scope.
    const listed = engine.list({ platform: 'youtube', channelId: 'UCxyz' })
    expect(listed).toContainEqual(expect.objectContaining({ code: 'glorpass', scope: 'library' }))
  })

  it('clearUserEmotes removes them from the shared pool', async () => {
    vi.mocked(fetchSevenTvChannel).mockResolvedValueOnce({
      setId: undefined,
      emotes: [sevenTvEmote('glorpass')]
    })
    const engine = new EmoteEngine()
    await engine.loadUserEmotes('twitch', '1')
    engine.clearUserEmotes()

    expect(engine.tokenize([{ type: 'text', text: 'glorpass' }], 'youtube', 'UCxyz')).toEqual([
      { type: 'text', text: 'glorpass' }
    ])
  })
})

describe('EmoteEngine provider toggles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchBttvGlobal).mockResolvedValue([bttvEmote('catJAM')])
    vi.mocked(fetchBttvChannel).mockResolvedValue([bttvEmote('chanJAM')])
  })

  afterEach(() => {
    vi.mocked(fetchBttvGlobal).mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockResolvedValue([])
  })

  it('skips a disabled provider entirely: no fetches, nothing listed or tokenized', async () => {
    const providers: EmoteProviderSettings = { sevenTv: true, bttv: false, ffz: true }
    const engine = new EmoteEngine(undefined, () => providers)
    await engine.loadGlobals()
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    await engine.loadUserEmotes('twitch', '578762718')

    expect(fetchBttvGlobal).not.toHaveBeenCalled()
    expect(fetchBttvChannel).not.toHaveBeenCalled()
    expect(fetchFfzGlobal).toHaveBeenCalled()
    expect(engine.tokenize([{ type: 'text', text: 'catJAM chanJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'catJAM chanJAM' }
    ])
    expect(engine.list({ platform: 'twitch', channelId: '123' })).toEqual([])
  })

  it('applyProviderSettings drops a disabled provider from every scope immediately', async () => {
    const providers: EmoteProviderSettings = { sevenTv: true, bttv: true, ffz: true }
    const engine = new EmoteEngine(undefined, () => providers)
    await engine.loadGlobals()
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    expect(engine.tokenize([{ type: 'text', text: 'catJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'catJAM' })
    ])

    providers.bttv = false
    const applied = engine.applyProviderSettings()
    // The drop is synchronous — no waiting on the re-fetches.
    expect(engine.tokenize([{ type: 'text', text: 'catJAM chanJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'catJAM chanJAM' }
    ])
    await applied
    expect(engine.list({ platform: 'twitch', channelId: '123' })).toEqual([])
  })

  it('applyProviderSettings re-fetches every known scope when a provider comes back', async () => {
    const providers: EmoteProviderSettings = { sevenTv: true, bttv: true, ffz: true }
    const engine = new EmoteEngine(undefined, () => providers)
    await engine.loadGlobals()
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))

    providers.bttv = false
    await engine.applyProviderSettings()
    providers.bttv = true
    await engine.applyProviderSettings()

    expect(fetchBttvGlobal).toHaveBeenCalledTimes(2)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    expect(engine.tokenize([{ type: 'text', text: 'catJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'catJAM' })
    ])
    expect(engine.list({ platform: 'twitch', channelId: '123' })).toContainEqual(
      expect.objectContaining({ code: 'chanJAM', scope: 'channel' })
    )
  })

  it('refreshEmotes re-fetches globals and every channel scope on demand', async () => {
    const engine = new EmoteEngine(undefined, () => ({ sevenTv: true, bttv: true, ffz: true }))
    await engine.loadGlobals()
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    expect(fetchBttvGlobal).toHaveBeenCalledTimes(1)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

    await engine.refreshEmotes()

    expect(fetchBttvGlobal).toHaveBeenCalledTimes(2)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toContainEqual(
      expect.objectContaining({ type: 'emote', code: 'chanJAM' })
    )
  })
})

describe('EmoteEngine bootstrap failure retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
    vi.mocked(fetchFfzGlobal).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvGlobal).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvGlobal).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed channel bootstrap and starts the 7TV watch when the set id arrives', async () => {
    vi.mocked(fetchFfzChannel).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(fetchBttvChannel).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(fetchSevenTvChannel)
      .mockResolvedValue({ setId: 'set-late', emotes: [sevenTvEmote('LateEmote')] })
      .mockRejectedValueOnce(new Error('offline'))
    const sockets: EventsSocket[] = []
    const engine = new EmoteEngine(() => {
      const socket: EventsSocket = { send: () => {}, close: () => {}, addEventListener: () => {} }
      sockets.push(socket)
      return socket
    })

    engine.ensureChannel('twitch', '123')
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.tokenize([{ type: 'text', text: 'LateEmote' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'LateEmote' }
    ])
    expect(sockets).toHaveLength(0) // no set id learned yet → no EventAPI watch

    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchSevenTvChannel).toHaveBeenCalledTimes(2)
    expect(engine.tokenize([{ type: 'text', text: 'LateEmote' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'LateEmote' })
    ])
    expect(sockets).toHaveLength(1) // the watch started as it would have at startup
    engine.dispose()
  })

  it('applies successful providers immediately and backs off retrying the failed one', async () => {
    vi.mocked(fetchSevenTvChannel).mockResolvedValue({
      setId: undefined,
      emotes: [sevenTvEmote('InstantEmote')]
    })
    vi.mocked(fetchBttvChannel)
      .mockResolvedValue([bttvEmote('catJAM')])
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
    const engine = new EmoteEngine()

    engine.ensureChannel('twitch', '123')
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.tokenize([{ type: 'text', text: 'InstantEmote' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'InstantEmote' })
    ])
    expect(engine.tokenize([{ type: 'text', text: 'catJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'catJAM' }
    ])

    // First retry after 30s fails again…
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    // …so the next one is due 60s later, not 30.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(3)
    expect(engine.tokenize([{ type: 'text', text: 'catJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'catJAM' })
    ])
    expect(engine.tokenize([{ type: 'text', text: 'InstantEmote' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'InstantEmote' })
    ])

    // Recovered: the retry cycle ends.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(3)
  })

  it('retries failed global fetches until they succeed', async () => {
    vi.mocked(fetchBttvGlobal)
      .mockResolvedValue([bttvEmote('GlobalJAM')])
      .mockRejectedValueOnce(new Error('offline'))
    vi.mocked(fetchFfzGlobal).mockRejectedValueOnce(new Error('offline'))
    const engine = new EmoteEngine()

    await engine.loadGlobals()
    expect(engine.tokenize([{ type: 'text', text: 'GlobalJAM' }], 'twitch', undefined)).toEqual([
      { type: 'text', text: 'GlobalJAM' }
    ])

    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchBttvGlobal).toHaveBeenCalledTimes(2)
    expect(engine.tokenize([{ type: 'text', text: 'GlobalJAM' }], 'twitch', undefined)).toEqual([
      expect.objectContaining({ type: 'emote', code: 'GlobalJAM' })
    ])

    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetchBttvGlobal).toHaveBeenCalledTimes(2)
  })

  it('caches a genuinely empty channel without retry back-off, re-checking only after five minutes', async () => {
    let now = 1_000_000
    const engine = new EmoteEngine(undefined, undefined, () => now)
    engine.ensureChannel('twitch', '123')
    await vi.advanceTimersByTimeAsync(1)
    now += 4 * 60_000
    await vi.advanceTimersByTimeAsync(4 * 60_000)

    // Four minutes of back-off-free quiet: an empty channel is not a failure to retry.
    expect(fetchFfzChannel).toHaveBeenCalledTimes(1)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(1)
    expect(fetchSevenTvChannel).toHaveBeenCalledTimes(1)

    // …but it is worth one look every five minutes, in case the channel signed up since.
    now += 60_000 + 1
    await vi.advanceTimersByTimeAsync(60_000 + 1)
    expect(fetchSevenTvChannel).toHaveBeenCalledTimes(2)
  })
})

describe('EmoteEngine releaseChannel', () => {
  beforeEach(() => {
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel)
      .mockReset()
      .mockResolvedValue([bttvEmote('chanJAM')])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
    vi.mocked(fetchFfzGlobal).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvGlobal).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvGlobal).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  it('drops the channel from its column, the shared library, and the re-fetch scopes', async () => {
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    // The shared library applies the channel's emotes in every column…
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'youtube', 'UCxyz')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'chanJAM' })
    ])

    engine.releaseChannel('twitch', '123')
    // …until the channel is released, then they stop tokenizing everywhere.
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'chanJAM' }
    ])
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'youtube', 'UCxyz')).toEqual([
      { type: 'text', text: 'chanJAM' }
    ])
    expect(engine.list({ platform: 'twitch', channelId: '123' })).toEqual([])

    // The scope is forgotten: a provider-toggle re-fetch no longer touches it.
    vi.mocked(fetchBttvChannel).mockClear()
    await engine.applyProviderSettings()
    expect(fetchBttvChannel).not.toHaveBeenCalled()
  })

  it('discards an in-flight load that finishes after the channel was released', async () => {
    let resolveBttv: ((value: ResolvedEmote[]) => void) | undefined
    vi.mocked(fetchBttvChannel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBttv = resolve
        })
    )
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')
    engine.releaseChannel('twitch', '123')
    resolveBttv?.([bttvEmote('chanJAM')])
    await new Promise((resolve) => setImmediate(resolve))

    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'chanJAM' }
    ])
    expect(engine.list({ platform: 'youtube', channelId: 'UCxyz' })).toEqual([])
  })

  it('keeps a channel re-ensured while its original load was still in flight', async () => {
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')
    engine.releaseChannel('twitch', '123')
    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))

    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'chanJAM' })
    ])
  })
})

describe('EmoteEngine load signal', () => {
  beforeEach(() => {
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  it('whenChannelLoaded waits for the first load to settle', async () => {
    let resolveBttv: ((value: ResolvedEmote[]) => void) | undefined
    vi.mocked(fetchBttvChannel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBttv = resolve
        })
    )
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')

    let settled = false
    const waited = engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' }).then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(settled).toBe(false)
    // This is exactly the window a message backlog would be tokenized in without the signal.
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      { type: 'text', text: 'chanJAM' }
    ])

    resolveBttv?.([bttvEmote('chanJAM')])
    await waited
    expect(settled).toBe(true)
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'chanJAM' })
    ])
  })

  it('whenChannelLoaded resolves in the same tick once loaded, and for a scope never ensured', async () => {
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')
    await engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' })

    const resolved: string[] = []
    void engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' }).then(() => {
      resolved.push('loaded')
    })
    void engine.whenChannelLoaded({ platform: 'youtube', channelId: 'UCnever' }).then(() => {
      resolved.push('unknown')
    })
    // No timers advanced: both must already be settled.
    await flushMicrotasks()

    expect(resolved).toEqual(['loaded', 'unknown'])
  })

  it('whenChannelLoaded resolves rather than rejects when the first load fails', async () => {
    vi.mocked(fetchBttvChannel).mockRejectedValueOnce(new Error('offline'))
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')

    await expect(
      engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' })
    ).resolves.toBeUndefined()
    engine.dispose()
  })
})

describe('EmoteEngine index-change events', () => {
  beforeEach(() => {
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  it('reports each scope once per load and coalesces the shared layer into one notification', async () => {
    vi.useFakeTimers()
    try {
      const engine = new EmoteEngine()
      const changes: IndexChange[] = []
      engine.onIndexChanged((changed) => {
        changes.push(changed)
      })

      engine.ensureChannel('twitch', '1')
      engine.ensureChannel('twitch', '2')
      engine.ensureChannel('youtube', 'UC3')
      await vi.advanceTimersByTimeAsync(1)

      const scopes = changes.filter((changed) => changed !== 'shared')
      expect(scopes).toHaveLength(3)
      expect(scopes).toContainEqual({ platform: 'twitch', channelId: '1' })
      expect(scopes).toContainEqual({ platform: 'twitch', channelId: '2' })
      expect(scopes).toContainEqual({ platform: 'youtube', channelId: 'UC3' })
      // Three rebuilds inside the window, still nothing emitted yet.
      expect(changes).not.toContain('shared')

      await vi.advanceTimersByTimeAsync(250)
      expect(changes.filter((changed) => changed === 'shared')).toEqual(['shared'])
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops notifying once the subscription is released', async () => {
    const engine = new EmoteEngine()
    const changes: IndexChange[] = []
    const unsubscribe = engine.onIndexChanged((changed) => {
      changes.push(changed)
    })
    const scopes = (): IndexChange[] => changes.filter((changed) => changed !== 'shared')

    engine.ensureChannel('twitch', '1')
    await engine.whenChannelLoaded({ platform: 'twitch', channelId: '1' })
    expect(scopes()).toEqual([{ platform: 'twitch', channelId: '1' }])

    unsubscribe()
    engine.ensureChannel('twitch', '2')
    await engine.whenChannelLoaded({ platform: 'twitch', channelId: '2' })

    expect(scopes()).toEqual([{ platform: 'twitch', channelId: '1' }])
    engine.dispose()
  })
})

describe('EmoteEngine not-found re-check', () => {
  beforeEach(() => {
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  it('re-checks a not-found scope on its own timer, without a second ensureChannel', async () => {
    // A Twitch source only calls ensureChannel when the room id first resolves, so the engine has to
    // own the five-minute re-check itself or a channel that adds a 7TV set later never gets it.
    vi.useFakeTimers()
    try {
      let now = 1_000_000
      const engine = new EmoteEngine(undefined, undefined, () => now)
      const scope = { platform: 'twitch', channelId: '123' } as const
      engine.ensureChannel(scope.platform, scope.channelId)
      await engine.whenChannelLoaded(scope)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

      vi.mocked(fetchBttvChannel).mockResolvedValue([bttvEmote('chanJAM')])
      now += 5 * 60_000 + 1
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      await engine.whenChannelLoaded(scope)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
      expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
        expect.objectContaining({ type: 'emote', code: 'chanJAM' })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-check a released scope', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000_000
      const engine = new EmoteEngine(undefined, undefined, () => now)
      engine.ensureChannel('twitch', '123')
      await engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' })
      engine.releaseChannel('twitch', '123')
      now += 6 * 60_000
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifies when the native Twitch catalog changes, so buffered rows re-tokenise', async () => {
    vi.useFakeTimers()
    try {
      const engine = new EmoteEngine()
      const seen: IndexChange[] = []
      engine.onIndexChanged((changed) => seen.push(changed))
      engine.setTwitchGlobal([])
      await vi.advanceTimersByTimeAsync(300)
      expect(seen).toContain('shared')
      engine.setTwitchChannel('123', [])
      expect(seen).toContainEqual({ platform: 'twitch', channelId: '123' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-fetches a scope every provider 404d, but not before five minutes have passed', async () => {
    let now = 1_000_000
    const engine = new EmoteEngine(undefined, undefined, () => now)
    const scope = { platform: 'twitch', channelId: '123' } as const
    engine.ensureChannel(scope.platform, scope.channelId)
    await engine.whenChannelLoaded(scope)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

    now += 4 * 60_000
    engine.ensureChannel(scope.platform, scope.channelId)
    await engine.whenChannelLoaded(scope)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

    // The channel signed up to a provider in the meantime.
    vi.mocked(fetchBttvChannel).mockResolvedValue([bttvEmote('chanJAM')])
    now += 2 * 60_000
    engine.ensureChannel(scope.platform, scope.channelId)
    await engine.whenChannelLoaded(scope)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    expect(engine.tokenize([{ type: 'text', text: 'chanJAM' }], 'twitch', '123')).toEqual([
      expect.objectContaining({ type: 'emote', code: 'chanJAM' })
    ])

    // Now that the scope has emotes it is cached for good again.
    now += 10 * 60_000
    engine.ensureChannel(scope.platform, scope.channelId)
    await engine.whenChannelLoaded(scope)
    expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
    engine.dispose()
  })

  it('treats a provider failure as retryable, not as not-found', async () => {
    vi.useFakeTimers()
    try {
      let now = 1_000_000
      vi.mocked(fetchBttvChannel).mockRejectedValueOnce(new Error('offline'))
      const engine = new EmoteEngine(undefined, undefined, () => now)
      engine.ensureChannel('twitch', '123')
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

      // Well past the re-check window, a re-ensure is still a no-op: the back-off owns the retry.
      now += 6 * 60_000
      engine.ensureChannel('twitch', '123')
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetchBttvChannel).toHaveBeenCalledTimes(2)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('EmoteEngine debug logging', () => {
  beforeEach(() => {
    vi.mocked(debugLog).mockClear()
    vi.mocked(fetchFfzChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchBttvChannel).mockReset().mockResolvedValue([])
    vi.mocked(fetchSevenTvChannel).mockReset().mockResolvedValue({ setId: undefined, emotes: [] })
  })

  it('logs one line per settled load with the per-provider counts', async () => {
    vi.mocked(fetchBttvChannel).mockResolvedValue([bttvEmote('chanJAM'), bttvEmote('pogJAM')])
    vi.mocked(fetchSevenTvChannel).mockResolvedValue({
      setId: undefined,
      emotes: [sevenTvEmote('glorpass')]
    })
    const engine = new EmoteEngine()
    engine.ensureChannel('twitch', '123')
    await engine.whenChannelLoaded({ platform: 'twitch', channelId: '123' })

    expect(debugLog).toHaveBeenCalledTimes(1)
    expect(debugLog).toHaveBeenCalledWith('emotes', 'scope loaded', {
      scope: 'twitch:123',
      ffz: 0,
      bttv: 2,
      sevenTv: 1,
      complete: true,
      notFound: false
    })
    engine.dispose()
  })

  it('marks an all-empty settled load as not found, and a failed one as incomplete', async () => {
    vi.useFakeTimers()
    try {
      const engine = new EmoteEngine()
      engine.ensureChannel('twitch', '123')
      await vi.advanceTimersByTimeAsync(1)
      expect(debugLog).toHaveBeenLastCalledWith(
        'emotes',
        'scope loaded',
        expect.objectContaining({ scope: 'twitch:123', complete: true, notFound: true })
      )

      vi.mocked(fetchFfzChannel).mockRejectedValueOnce(new Error('offline'))
      engine.ensureChannel('youtube', 'UCxyz')
      await vi.advanceTimersByTimeAsync(1)
      expect(debugLog).toHaveBeenLastCalledWith(
        'emotes',
        'scope loaded',
        expect.objectContaining({ scope: 'youtube:UCxyz', complete: false, notFound: false })
      )
      expect(debugLog).toHaveBeenCalledTimes(2)
      engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
