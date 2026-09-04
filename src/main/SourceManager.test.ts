import { describe, expect, it } from 'vitest'
import { type EmoteScope, SourceManager } from '@main/SourceManager'
import { BaseChatSource } from '@main/sources/ChatSource'
import type { ChatEvent, ChatMessage, Platform } from '@shared/model'

class FakeSource extends BaseChatSource {
  readonly platform: Platform = 'twitch'

  constructor(readonly id: string) {
    super()
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}

  /** Test hook to emit a message as if it arrived from the network. */
  fire(message: ChatMessage): void {
    this.emitMessage(message)
  }
}

function message(id: string, channelId: string): ChatMessage {
  return {
    id,
    platform: 'twitch',
    channelId,
    timestamp: 0,
    author: {
      id: 'u',
      name: 'u',
      displayName: 'u',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [{ type: 'text', text: 'hi' }]
  }
}

function messageCount(events: ChatEvent[]): number {
  return events.filter((event) => event.kind === 'message').length
}

describe('SourceManager listener lifecycle', () => {
  it('stops delivering events from a source after it is removed', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const source = new FakeSource('twitch:foo')

    await manager.add(source, '#foo')
    source.fire(message('a', source.id))
    expect(messageCount(events)).toBe(1)

    await manager.remove(source.id)
    // A late emit from an operation that was in flight at removal must not reach the sink.
    source.fire(message('b', source.id))
    expect(messageCount(events)).toBe(1)
  })

  it('does not deliver events from a disposed source', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const source = new FakeSource('twitch:bar')

    await manager.add(source, '#bar')
    await manager.disposeAll()
    source.fire(message('c', source.id))
    expect(messageCount(events)).toBe(0)
  })

  it('re-adding the same id attaches fresh listeners that deliver', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const first = new FakeSource('twitch:baz')
    await manager.add(first, '#baz')
    await manager.remove(first.id)

    const second = new FakeSource('twitch:baz')
    await manager.add(second, '#baz')
    second.fire(message('d', second.id))
    // Only the re-added source delivers; the removed one stays silent.
    first.fire(message('e', first.id))
    expect(messageCount(events)).toBe(1)
  })
})

class ControllableSource extends BaseChatSource {
  readonly platform: Platform = 'twitch'
  #rejectConnect: ((error: unknown) => void) | undefined

  constructor(readonly id: string) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((_resolve, reject) => {
      this.#rejectConnect = reject
    })
  }

  /** Reject the still-pending connect, simulating a late bootstrap failure. */
  failConnect(): void {
    this.#rejectConnect?.(new Error('connect failed'))
  }

  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
}

class FakeYouTubeSource extends BaseChatSource {
  readonly platform: Platform = 'youtube'
  #videoId: string | undefined

  constructor(
    readonly id: string,
    videoId: string | undefined
  ) {
    super()
    this.#videoId = videoId
  }

  resolvedVideoId(): string | undefined {
    return this.#videoId
  }

  /** Test hook: resolve onto a video and announce it (as the real source does on a stream roll). */
  resolve(videoId: string): void {
    this.#videoId = videoId
    this.emitResolved(videoId)
  }

  /** Test hook: announce the resolved stream title (as the real source does once it has the info). */
  announceTitle(title: string): void {
    this.emitTitle(title)
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
}

describe('SourceManager relabels a channel to its stream title', () => {
  it('replaces a @handle label with the stream title and re-announces, ignoring an unchanged title', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const source = new FakeYouTubeSource('youtube:@handle', undefined)
    await manager.add(source, 'yt:@handle')

    source.announceTitle('Morning Coffee ☕ LIVE')
    expect(manager.list()[0]?.label).toBe('Morning Coffee ☕ LIVE')
    const channelEvents = () => events.filter((event) => event.kind === 'channels').length
    const afterFirst = channelEvents()

    // Re-announcing the same title is a no-op (no relabel, no extra channels event).
    source.announceTitle('Morning Coffee ☕ LIVE')
    expect(channelEvents()).toBe(afterFirst)
  })
})

describe('SourceManager.youtubeVideoIds', () => {
  it('collects resolved video ids from YouTube sources and ignores Twitch / unresolved', async () => {
    const manager = new SourceManager(() => {})
    await manager.add(new FakeYouTubeSource('youtube:@handle', 'aaaaaaaaaaa'), 'yt:@handle')
    await manager.add(new FakeYouTubeSource('youtube:bbbbbbbbbbb', 'bbbbbbbbbbb'), 'yt:bbb')
    await manager.add(new FakeYouTubeSource('youtube:@pending', undefined), 'yt:@pending')
    await manager.add(new FakeSource('twitch:foo'), '#foo')
    expect(manager.youtubeVideoIds()).toEqual(new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb']))
  })
})

describe('SourceManager de-duplicates a follower onto a standalone video column', () => {
  const VIDEO = 'vid12345678' // 11-char video id
  const STANDALONE = 'youtube:vid12345678'

  it('removes the standalone column when a @handle column rolls onto its video', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    await manager.add(new FakeYouTubeSource(STANDALONE, VIDEO), 'yt:vid')
    const follower = new FakeYouTubeSource('youtube:@handle', undefined)
    await manager.add(follower, 'yt:@handle')
    follower.resolve(VIDEO) // live ended → rolled onto the waiting room that's already open
    expect(removed).toEqual([STANDALONE])
  })

  it('keeps a standalone column when no other source is on that video', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    const standalone = new FakeYouTubeSource(STANDALONE, VIDEO)
    await manager.add(standalone, 'yt:vid')
    standalone.resolve(VIDEO) // resolves to itself; nothing else follows it
    expect(removed).toEqual([])
  })

  it('does nothing when no standalone column exists for the resolved video', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    const follower = new FakeYouTubeSource('youtube:@handle', undefined)
    await manager.add(follower, 'yt:@handle')
    follower.resolve(VIDEO)
    expect(removed).toEqual([])
  })

  it('removes a standalone column that has not resolved yet when a follower lands on its video', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    await manager.add(new FakeYouTubeSource(STANDALONE, undefined), 'yt:vid')
    const follower = new FakeYouTubeSource('youtube:@handle', undefined)
    await manager.add(follower, 'yt:@handle')
    follower.resolve(VIDEO)
    expect(removed).toEqual([STANDALONE])
  })
})

describe('SourceManager de-duplicates two follower columns on the same video', () => {
  const VIDEO = 'vid12345678'
  const HANDLE = 'youtube:@handle'
  const CHANNEL = 'youtube:UCaaaaaaaaaaaaaaaaaaaaaa'

  it('keeps the first-added follower and removes the later one', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    const first = new FakeYouTubeSource(HANDLE, undefined)
    const second = new FakeYouTubeSource(CHANNEL, undefined)
    await manager.add(first, 'yt:@handle')
    await manager.add(second, 'yt:UC…')
    first.resolve(VIDEO)
    expect(removed).toEqual([])
    second.resolve(VIDEO)
    expect(removed).toEqual([CHANNEL])
  })

  it('keeps the first-added follower even when the later one resolves first', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    const first = new FakeYouTubeSource(HANDLE, undefined)
    const second = new FakeYouTubeSource(CHANNEL, undefined)
    await manager.add(first, 'yt:@handle')
    await manager.add(second, 'yt:UC…')
    second.resolve(VIDEO)
    expect(removed).toEqual([])
    first.resolve(VIDEO)
    expect(removed).toEqual([CHANNEL])
  })

  it('leaves followers on different videos alone', async () => {
    const removed: string[] = []
    const manager = new SourceManager(
      () => {},
      (id) => removed.push(id)
    )
    const first = new FakeYouTubeSource(HANDLE, undefined)
    const second = new FakeYouTubeSource(CHANNEL, undefined)
    await manager.add(first, 'yt:@handle')
    await manager.add(second, 'yt:UC…')
    first.resolve(VIDEO)
    second.resolve('other1234ok')
    expect(removed).toEqual([])
  })
})

class ScopedSource extends BaseChatSource {
  readonly platform: Platform = 'youtube'
  readonly #scope: EmoteScope | undefined

  constructor(
    readonly id: string,
    scope?: EmoteScope
  ) {
    super()
    this.#scope = scope
  }

  emoteScope(): EmoteScope | undefined {
    return this.#scope
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
}

describe('SourceManager emote-scope release', () => {
  const SCOPE: EmoteScope = { platform: 'youtube', channelId: 'UC1' }

  it('releases a scope only when the last source using it is removed', async () => {
    const released: EmoteScope[] = []
    const manager = new SourceManager(
      () => {},
      () => {},
      (scope) => released.push(scope)
    )
    // Two columns share one creator's emote scope (e.g. two streams of one YouTube channel).
    await manager.add(new ScopedSource('youtube:vid-a', SCOPE), 'a')
    await manager.add(new ScopedSource('youtube:vid-b', SCOPE), 'b')

    await manager.remove('youtube:vid-a')
    expect(released).toEqual([]) // the surviving column keeps its emotes

    await manager.remove('youtube:vid-b')
    expect(released).toEqual([SCOPE])
  })

  it('releases nothing for a source that never resolved a scope', async () => {
    const released: EmoteScope[] = []
    const manager = new SourceManager(
      () => {},
      () => {},
      (scope) => released.push(scope)
    )
    await manager.add(new ScopedSource('youtube:pending'), 'pending')
    await manager.remove('youtube:pending')
    expect(released).toEqual([])
  })
})

describe('SourceManager late connect rejection', () => {
  it('ignores a connect rejection from a source that was removed and re-added', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))

    const first = new ControllableSource('twitch:foo')
    await manager.add(first, '#foo')
    await manager.remove(first.id)

    // Same id re-added with a fresh source while the first connect is still pending.
    const second = new ControllableSource('twitch:foo')
    await manager.add(second, '#foo')

    first.failConnect()
    await Promise.resolve()
    await Promise.resolve()

    const errored = events.some(
      (event) => event.kind === 'status' && event.status.state === 'error'
    )
    expect(errored).toBe(false)
  })
})

class KeyedSource extends BaseChatSource {
  readonly platform: Platform = 'youtube'

  constructor(
    readonly id: string,
    private readonly key: string
  ) {
    super()
  }

  streamerKey(): string {
    return this.key
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
}

describe('SourceManager.list carries streamerKey', () => {
  it('uses the source-provided key, falling back to legacyStreamerKey when the source has none', async () => {
    const manager = new SourceManager(() => {})
    await manager.add(new KeyedSource('youtube:@handle', 'mossflower'), 'yt:@handle')
    await manager.add(new FakeSource('twitch:foo'), '#foo')

    const list = manager.list()
    expect(list.find((channel) => channel.id === 'youtube:@handle')?.streamerKey).toBe('mossflower')
    // FakeSource exposes no streamerKey() — falls back to legacyStreamerKey('twitch:foo').
    expect(list.find((channel) => channel.id === 'twitch:foo')?.streamerKey).toBe('foo')
  })
})

class ResolvingYouTubeSource extends BaseChatSource {
  readonly platform: Platform = 'youtube'
  #creator: { channelId: string; name: string } | undefined

  constructor(readonly id: string) {
    super()
  }

  creator(): { channelId: string; name: string } | undefined {
    return this.#creator
  }

  streamerKey(): string {
    return this.#creator === undefined ? 'pending' : this.#creator.name.toLowerCase()
  }

  /** Test hook: resolve the creator and announce a status change, as the real source does. */
  resolveCreator(channelId: string, name: string): void {
    this.#creator = { channelId, name }
    this.setStatus({ state: 'live' })
  }

  /** Test hook: a further status change, to prove onIdentityResolved doesn't re-fire. */
  end(): void {
    this.setStatus({ state: 'ended' })
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
}

describe('SourceManager onIdentityResolved', () => {
  it('fires once with the resolved streamer key and creator id when a YouTube source resolves', async () => {
    const resolved: Array<{
      sourceId: string
      identity: { streamerKey: string; creatorId?: string }
    }> = []
    const manager = new SourceManager(
      () => {},
      () => {},
      () => {},
      (sourceId, identity) => resolved.push({ sourceId, identity })
    )
    const source = new ResolvingYouTubeSource('youtube:@handle')
    await manager.add(source, 'yt:@handle')

    source.resolveCreator('UCmade-up', 'Moss Flower')
    expect(resolved).toEqual([
      {
        sourceId: 'youtube:@handle',
        identity: { streamerKey: 'moss flower', creatorId: 'UCmade-up' }
      }
    ])

    // A further status change on the same (already-resolved) source must not re-fire it.
    source.end()
    expect(resolved).toHaveLength(1)
  })

  it('never fires for a source whose creator never resolves', async () => {
    const resolved: unknown[] = []
    const manager = new SourceManager(
      () => {},
      () => {},
      () => {},
      (sourceId, identity) => resolved.push({ sourceId, identity })
    )
    await manager.add(new FakeSource('twitch:foo'), '#foo')
    expect(resolved).toEqual([])
  })
})

describe('SourceManager reconnectAll', () => {
  class SpySource extends BaseChatSource {
    connects = 0
    disconnects = 0
    failConnect = false
    constructor(
      readonly id: string,
      readonly platform: Platform = 'twitch'
    ) {
      super()
    }
    async connect(): Promise<void> {
      this.connects += 1
      if (this.failConnect) {
        throw new Error('reconnect boom')
      }
    }
    async disconnect(): Promise<void> {
      this.disconnects += 1
    }
    async send(): Promise<void> {}
  }

  it('disconnects and reconnects every source across platforms', async () => {
    const manager = new SourceManager(() => {})
    const tw = new SpySource('twitch:a', 'twitch')
    const yt = new SpySource('youtube:b', 'youtube')
    await manager.add(tw, '#a')
    await manager.add(yt, 'b')
    // add() performs the initial connect; count only what reconnectAll does.
    tw.connects = 0
    yt.connects = 0

    await manager.reconnectAll()

    expect([tw.disconnects, tw.connects]).toEqual([1, 1])
    expect([yt.disconnects, yt.connects]).toEqual([1, 1])
  })

  it('surfaces one source’s failed reconnect on its column but still reconnects the rest', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const bad = new SpySource('twitch:bad')
    const good = new SpySource('twitch:good')
    await manager.add(bad, '#bad')
    await manager.add(good, '#good')
    good.connects = 0 // add() already connected; count only reconnectAll's connect
    bad.failConnect = true

    await manager.reconnectAll()

    expect(good.connects).toBe(1) // the failure didn't abandon the rest
    const errors = events.filter(
      (event) => event.kind === 'status' && event.status.state === 'error'
    )
    expect(errors.map((event) => event.kind === 'status' && event.channelId)).toContain(
      'twitch:bad'
    )
  })

  it('does not reconnect a source removed while its disconnect was in flight', async () => {
    const manager = new SourceManager(() => {})
    const disconnectReleases: Array<() => void> = []
    class BlockingSource extends SpySource {
      override disconnect(): Promise<void> {
        this.disconnects += 1
        return new Promise((resolve) => disconnectReleases.push(resolve))
      }
    }
    const source = new BlockingSource('twitch:z')
    await manager.add(source, '#z')
    source.connects = 0 // add() already connected; count only what reconnect does

    const reconnect = manager.reconnectAll() // enters disconnect() and blocks there (release #0)
    await Promise.resolve()
    const removal = manager.remove(source.id) // remove() also calls disconnect() and blocks (release #1)
    await Promise.resolve()
    disconnectReleases[1]?.() // let remove()'s disconnect resolve → it deletes the source from the map
    await removal
    disconnectReleases[0]?.() // now let the reconnect's disconnect resolve → the guard should skip connect
    await reconnect

    expect(source.connects).toBe(0) // the removed source must not be reconnected (a leaked connection)
  })
})

describe('SourceManager re-announces channels when a creator resolves', () => {
  it('emits a channels event carrying the creator id once identity is known', async () => {
    const events: ChatEvent[] = []
    const manager = new SourceManager((event) => events.push(event))
    const source = new ResolvingYouTubeSource('youtube:aaaaaaaaaaa')
    await manager.add(source, 'yt:aaaaaaaaaaa')
    const before = events.filter((event) => event.kind === 'channels').length

    source.resolveCreator('UCmade-up', 'Moss Flower')

    const after = events.filter(
      (event): event is Extract<ChatEvent, { kind: 'channels' }> => event.kind === 'channels'
    )
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)?.channels[0]?.creatorId).toBe('UCmade-up')
  })
})

describe('SourceManager reports an identity change', () => {
  it('reports again when a handle resolves to a different creator than before', async () => {
    const resolved: string[] = []
    const manager = new SourceManager(
      () => {},
      () => {},
      () => {},
      (_sourceId, identity) => resolved.push(identity.creatorId ?? '')
    )
    const source = new ResolvingYouTubeSource('youtube:@handle')
    await manager.add(source, 'yt:@handle')
    source.resolveCreator('UCold', 'Old Owner')
    source.end() // a further status change with the same creator: no repeat
    source.resolveCreator('UCnew', 'New Owner') // same status as before, so nothing emits yet
    source.end() // the next status change carries the new owner
    expect(resolved).toEqual(['UCold', 'UCnew'])
  })

  it('reports again when the same creator resolves to a better key', async () => {
    const keys: string[] = []
    const manager = new SourceManager(
      () => {},
      () => {},
      () => {},
      (_sourceId, identity) => keys.push(identity.streamerKey)
    )
    const source = new ResolvingYouTubeSource('youtube:aaaaaaaaaaa')
    await manager.add(source, 'yt:video')
    source.resolveCreator('UC1', 'Display Name')
    source.end()
    source.resolveCreator('UC1', 'handle') // the fake keys by name; a real source by handle
    source.end()
    expect(keys).toEqual(['display name', 'handle'])
  })
})
