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
  const CHANNEL = 'youtube:UCSJ4gkVC6NrvII8umztf0Ow'

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
