import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the real `resolveActiveEmote` (SevenTvEvents uses it); fake only the fetchers.
vi.mock('@main/emotes/providers/sevenTv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/emotes/providers/sevenTv')>()
  return { ...actual, fetchSevenTvGlobal: vi.fn(), fetchSevenTvChannel: vi.fn() }
})
vi.mock('@main/emotes/providers/bttv', () => ({
  fetchBttvGlobal: vi.fn().mockResolvedValue([]),
  fetchBttvChannel: vi.fn().mockResolvedValue([])
}))
vi.mock('@main/emotes/providers/ffz', () => ({
  fetchFfzGlobal: vi.fn().mockResolvedValue([]),
  fetchFfzChannel: vi.fn().mockResolvedValue([])
}))

import type { EmoteProviderSettings } from '@shared/model'
import { EmoteEngine } from '@main/emotes/EmoteEngine'
import { SevenTvEvents, type SevenTvSetChange } from '@main/emotes/SevenTvEvents'
import { fetchSevenTvChannel, fetchSevenTvGlobal } from '@main/emotes/providers/sevenTv'
import type { ResolvedEmote } from '@main/emotes/types'

type Listener = (event: { data?: unknown }) => void

class FakeSocket {
  readonly sent: string[] = []
  closed = false
  readonly #listeners = new Map<string, Listener[]>()

  addEventListener(type: 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.#listeners.get(type) ?? []
    list.push(listener)
    this.#listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event)
    }
  }

  frame(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  hello(heartbeatIntervalMs = 30_000): void {
    this.frame({
      op: 1,
      t: 1,
      d: { heartbeat_interval: heartbeatIntervalMs, session_id: 'abc', subscription_limit: 500 }
    })
  }

  heartbeat(): void {
    this.frame({ op: 2, t: 2, d: { count: 1 } })
  }

  /** Emote-set ids this socket was asked to subscribe to, in send order. */
  subscriptions(): string[] {
    return this.#setOps(35)
  }

  /** Emote-set ids this socket was asked to unsubscribe from, in send order. */
  unsubscriptions(): string[] {
    return this.#setOps(36)
  }

  #setOps(op: number): string[] {
    const ids: string[] = []
    for (const raw of this.sent) {
      const msg = JSON.parse(raw) as { op: number; d: { condition: { object_id: string } } }
      if (msg.op === op) {
        ids.push(msg.d.condition.object_id)
      }
    }
    return ids
  }
}

function socketTracker(): {
  sockets: FakeSocket[]
  create: () => FakeSocket
  at: (index: number) => FakeSocket
} {
  const sockets: FakeSocket[] = []
  return {
    sockets,
    create: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    at: (index: number) => {
      const socket = sockets[index]
      if (socket === undefined) {
        throw new Error(`no socket #${index} was created`)
      }
      return socket
    }
  }
}

function emoteSetDispatch(setId: string, changes: Record<string, unknown>): unknown {
  return { op: 0, t: 2, d: { type: 'emote_set.update', body: { id: setId, kind: 2, ...changes } } }
}

function sevenTvEmote(code: string, id: string): ResolvedEmote {
  return {
    code,
    provider: '7tv',
    url: `https://cdn.7tv.app/emote/${id}/2x.webp`,
    zeroWidth: false,
    animated: false
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(console.log).mockRestore()
})

describe('SevenTvEvents subscriptions', () => {
  it('subscribes on HELLO, and immediately for sets watched after connecting', () => {
    const tracker = socketTracker()
    const events = new SevenTvEvents(() => {}, tracker.create)

    events.watch('set-a')
    expect(tracker.sockets).toHaveLength(1)
    expect(tracker.at(0).sent).toHaveLength(0)

    tracker.at(0).hello()
    expect(tracker.at(0).subscriptions()).toEqual(['set-a'])

    events.watch('set-b')
    expect(tracker.at(0).subscriptions()).toEqual(['set-a', 'set-b'])

    // Watching the same set twice never double-subscribes (4009 Already Subscribed).
    events.watch('set-a')
    expect(tracker.at(0).subscriptions()).toEqual(['set-a', 'set-b'])
    events.stop()
  })

  it('reconnects with backoff and resubscribes all sets after 3 missed heartbeat cycles', () => {
    vi.useFakeTimers()
    try {
      const tracker = socketTracker()
      const events = new SevenTvEvents(() => {}, tracker.create)
      events.watch('set-a')
      events.watch('set-b')
      tracker.at(0).hello(1_000)

      // A heartbeat inside the 3-cycle window keeps the connection alive.
      vi.advanceTimersByTime(2_999)
      tracker.at(0).heartbeat()
      vi.advanceTimersByTime(2_999)
      expect(tracker.at(0).closed).toBe(false)

      // Silence for 3 full cycles kills the socket…
      vi.advanceTimersByTime(1)
      expect(tracker.at(0).closed).toBe(true)
      expect(tracker.sockets).toHaveLength(1)

      // …and the first backoff step (1 s) opens a new one that resubscribes everything.
      vi.advanceTimersByTime(1_000)
      expect(tracker.sockets).toHaveLength(2)
      tracker.at(1).hello(1_000)
      expect(tracker.at(1).subscriptions()).toEqual(['set-a', 'set-b'])
      events.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed frames, unknown opcodes, and apply errors', () => {
    const applied: Array<[string, SevenTvSetChange]> = []
    const tracker = socketTracker()
    const events = new SevenTvEvents((setId, change) => {
      applied.push([setId, change])
      throw new Error('engine exploded')
    }, tracker.create)
    events.watch('set-a')
    const socket = tracker.at(0)
    socket.hello()

    socket.emit('message', { data: 'not json' })
    socket.emit('message', { data: '42' })
    socket.emit('message', {})
    socket.frame({ op: 99, d: {} })
    socket.frame({ op: 0 })
    socket.frame({ op: 0, d: { type: 'user.update', body: { id: 'set-a' } } })
    socket.frame(emoteSetDispatch('set-a', { pushed: 'nope' }))
    socket.frame({ op: 0, d: { type: 'emote_set.update', body: { id: 5, pushed: [] } } })
    socket.frame(
      emoteSetDispatch('set-a', {
        pushed: [{ key: 'badges', value: { id: 'e9', name: 'NotAnEmote' } }],
        pulled: [null, { key: 'emotes', old_value: { name: 7 } }],
        updated: [{ key: 'emotes', old_value: null, value: { id: 'e9' } }]
      })
    )
    expect(applied).toHaveLength(0)

    // A valid dispatch reaches apply, and the throw inside it never kills the socket.
    socket.frame(
      emoteSetDispatch('set-a', {
        pushed: [{ key: 'emotes', index: 0, value: { id: 'e1', name: 'Fine' } }]
      })
    )
    expect(applied).toHaveLength(1)
    expect(socket.closed).toBe(false)
    events.stop()
  })

  it('unsubscribes an unwatched set and drops it from the reconnect replay', () => {
    vi.useFakeTimers()
    try {
      const tracker = socketTracker()
      const events = new SevenTvEvents(() => {}, tracker.create)
      events.watch('set-a')
      events.watch('set-b')
      tracker.at(0).hello(1_000)

      events.unwatch('set-a')
      expect(tracker.at(0).unsubscriptions()).toEqual(['set-a'])
      // Unwatching a set that was never watched sends nothing.
      events.unwatch('set-unknown')
      expect(tracker.at(0).unsubscriptions()).toEqual(['set-a'])

      // After a heartbeat-stall reconnect, only the still-watched set resubscribes.
      vi.advanceTimersByTime(3_000)
      expect(tracker.at(0).closed).toBe(true)
      vi.advanceTimersByTime(1_000)
      tracker.at(1).hello(1_000)
      expect(tracker.at(1).subscriptions()).toEqual(['set-b'])
      events.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SevenTvEvents HELLO timeout', () => {
  it('closes a socket that never sends HELLO and reconnects with backoff', () => {
    vi.useFakeTimers()
    try {
      const tracker = socketTracker()
      const events = new SevenTvEvents(() => {}, tracker.create)
      events.watch('set-a')

      vi.advanceTimersByTime(14_999)
      expect(tracker.at(0).closed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(tracker.at(0).closed).toBe(true)

      // The normal backoff path takes over and the new session resubscribes.
      vi.advanceTimersByTime(1_000)
      expect(tracker.sockets).toHaveLength(2)
      tracker.at(1).hello()
      expect(tracker.at(1).subscriptions()).toEqual(['set-a'])
      events.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a HELLO inside the window disarms the timeout', () => {
    vi.useFakeTimers()
    try {
      const tracker = socketTracker()
      const events = new SevenTvEvents(() => {}, tracker.create)
      events.watch('set-a')
      tracker.at(0).hello(30_000)

      vi.advanceTimersByTime(20_000)
      expect(tracker.at(0).closed).toBe(false)
      expect(tracker.sockets).toHaveLength(1)
      events.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('EmoteEngine live 7TV updates', () => {
  it('applies pushed/pulled/updated dispatches to the global set', async () => {
    vi.mocked(fetchSevenTvGlobal).mockResolvedValue({
      setId: 'set-g',
      emotes: [sevenTvEmote('OldEmote', 'e1')]
    })
    const tracker = socketTracker()
    const engine = new EmoteEngine(tracker.create)
    await engine.loadGlobals()
    const socket = tracker.at(0)
    socket.hello()
    expect(socket.subscriptions()).toEqual(['set-g'])

    // pushed → the new emote tokenizes everywhere, with flags mapped (256 = zero-width).
    socket.frame(
      emoteSetDispatch('set-g', {
        pushed: [
          {
            key: 'emotes',
            index: 1,
            value: { id: 'e2', name: 'NewEmote', flags: 0, data: { animated: true, flags: 256 } }
          }
        ]
      })
    )
    expect(engine.tokenize([{ type: 'text', text: 'NewEmote' }], 'twitch', undefined)).toEqual([
      {
        type: 'emote',
        code: 'NewEmote',
        url: 'https://cdn.7tv.app/emote/e2/2x.webp',
        provider: '7tv',
        zeroWidth: true,
        animated: true
      }
    ])

    // pulled → the old emote stops tokenizing.
    socket.frame(
      emoteSetDispatch('set-g', {
        pulled: [
          { key: 'emotes', index: 0, old_value: { id: 'e1', name: 'OldEmote' }, value: null }
        ]
      })
    )
    expect(engine.tokenize([{ type: 'text', text: 'OldEmote' }], 'twitch', undefined)).toEqual([
      { type: 'text', text: 'OldEmote' }
    ])

    // updated (rename) → the new name tokenizes, the old one is gone.
    socket.frame(
      emoteSetDispatch('set-g', {
        updated: [
          {
            key: 'emotes',
            index: 1,
            old_value: { id: 'e2', name: 'NewEmote' },
            value: { id: 'e2', name: 'FreshEmote', flags: 0, data: { animated: true } }
          }
        ]
      })
    )
    expect(
      engine.tokenize([{ type: 'text', text: 'FreshEmote NewEmote' }], 'twitch', undefined)
    ).toEqual([
      {
        type: 'emote',
        code: 'FreshEmote',
        url: 'https://cdn.7tv.app/emote/e2/2x.webp',
        provider: '7tv',
        zeroWidth: false,
        animated: true
      },
      { type: 'text', text: ' NewEmote' }
    ])
    engine.dispose()
  })

  it('subscribes to channel sets loaded after connect and updates that channel', async () => {
    vi.mocked(fetchSevenTvGlobal).mockResolvedValue({ setId: 'set-g', emotes: [] })
    vi.mocked(fetchSevenTvChannel).mockResolvedValue({ setId: 'set-c', emotes: [] })
    const tracker = socketTracker()
    const engine = new EmoteEngine(tracker.create)
    await engine.loadGlobals()
    tracker.at(0).hello()

    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    expect(tracker.at(0).subscriptions()).toEqual(['set-g', 'set-c'])

    tracker.at(0).frame(
      emoteSetDispatch('set-c', {
        pushed: [{ key: 'emotes', index: 0, value: { id: 'e3', name: 'chanEmote' } }]
      })
    )
    expect(engine.tokenize([{ type: 'text', text: 'chanEmote' }], 'twitch', '123')).toEqual([
      {
        type: 'emote',
        code: 'chanEmote',
        url: 'https://cdn.7tv.app/emote/e3/2x.webp',
        provider: '7tv',
        zeroWidth: false,
        animated: false
      }
    ])
    engine.dispose()
  })

  it('unwatches a channel set when releaseChannel drops its last scope', async () => {
    vi.mocked(fetchSevenTvGlobal).mockResolvedValue({ setId: 'set-g', emotes: [] })
    vi.mocked(fetchSevenTvChannel).mockResolvedValue({ setId: 'set-c', emotes: [] })
    const tracker = socketTracker()
    const engine = new EmoteEngine(tracker.create)
    await engine.loadGlobals()
    tracker.at(0).hello()

    engine.ensureChannel('twitch', '123')
    await new Promise((resolve) => setImmediate(resolve))
    expect(tracker.at(0).subscriptions()).toEqual(['set-g', 'set-c'])

    engine.releaseChannel('twitch', '123')
    expect(tracker.at(0).unsubscriptions()).toEqual(['set-c'])
    engine.dispose()
  })
})

describe('EmoteEngine 7TV provider toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchSevenTvGlobal).mockResolvedValue({
      setId: 'set-g',
      emotes: [sevenTvEmote('PogTv', 'e1')]
    })
  })

  it('never fetches 7TV or opens the EventAPI socket while 7TV is disabled', async () => {
    const tracker = socketTracker()
    const providers: EmoteProviderSettings = { sevenTv: false, bttv: true, ffz: true }
    const engine = new EmoteEngine(tracker.create, () => providers)
    await engine.loadGlobals()

    expect(fetchSevenTvGlobal).not.toHaveBeenCalled()
    expect(tracker.sockets).toHaveLength(0)
    expect(engine.tokenize([{ type: 'text', text: 'PogTv' }], 'twitch', undefined)).toEqual([
      { type: 'text', text: 'PogTv' }
    ])
    engine.dispose()
  })

  it('stops the socket when 7TV is toggled off and restarts it when toggled back on', async () => {
    const tracker = socketTracker()
    const providers: EmoteProviderSettings = { sevenTv: true, bttv: true, ffz: true }
    const engine = new EmoteEngine(tracker.create, () => providers)
    await engine.loadGlobals()
    expect(tracker.sockets).toHaveLength(1)
    tracker.at(0).hello()
    expect(tracker.at(0).subscriptions()).toEqual(['set-g'])

    providers.sevenTv = false
    await engine.applyProviderSettings()
    expect(tracker.at(0).closed).toBe(true)
    expect(tracker.sockets).toHaveLength(1)
    expect(engine.tokenize([{ type: 'text', text: 'PogTv' }], 'twitch', undefined)).toEqual([
      { type: 'text', text: 'PogTv' }
    ])

    providers.sevenTv = true
    await engine.applyProviderSettings()
    expect(tracker.sockets).toHaveLength(2)
    tracker.at(1).hello()
    expect(tracker.at(1).subscriptions()).toEqual(['set-g'])
    expect(engine.tokenize([{ type: 'text', text: 'PogTv' }], 'twitch', undefined)).toEqual([
      expect.objectContaining({ type: 'emote', code: 'PogTv' })
    ])
    engine.dispose()
  })
})
