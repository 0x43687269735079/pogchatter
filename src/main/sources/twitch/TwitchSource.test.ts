import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage as TwitchChatMessage } from '@twurple/chat'
import type { ChatMessage, ClearTarget, SourceStatus } from '@shared/model'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import type { TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import type { TwitchBadgeProvider } from '@main/sources/twitch/TwitchBadgeProvider'
import { TwitchCheermoteProvider } from '@main/sources/twitch/TwitchCheermoteProvider'
import type { TwitchEmoteProvider } from '@main/sources/twitch/TwitchEmoteProvider'
import { encodeTwitchMenuToken } from '@main/sources/twitch/normalize'
import { TwitchSource, type TwitchSourceOptions } from '@main/sources/twitch/TwitchSource'

// Mock the Helix boundary: the fake ApiClient records the moderation calls and the user
// context they ran under, exactly where the real one would hit the network.
const helix = vi.hoisted(() => ({
  asUser: vi.fn(),
  deleteChatMessages: vi.fn(),
  banUser: vi.fn(),
  getModeratedChannels: vi.fn(),
  getStreamByUserName: vi.fn(),
  getUserById: vi.fn(),
  getUsersByNames: vi.fn()
}))

vi.mock('@twurple/api', () => ({
  ApiClient: class {
    moderation = {
      deleteChatMessages: helix.deleteChatMessages,
      banUser: helix.banUser,
      getModeratedChannelsPaginated: () => ({ getAll: helix.getModeratedChannels })
    }
    streams = { getStreamByUserName: helix.getStreamByUserName }
    users = { getUserById: helix.getUserById, getUsersByNames: helix.getUsersByNames }
    async asUser<T>(user: string, runner: (ctx: unknown) => Promise<T>): Promise<T> {
      helix.asUser(user)
      return await runner(this)
    }
  }
}))

// Stub the IRC boundary so connect() opens no socket: each fake ChatClient records its handlers
// for the tests to fire, and lands in `irc.clients`. Everything else in @twurple/chat stays real
// (normalize uses its parseChatMessage).
const irc = vi.hoisted(() => ({
  clients: [] as Array<{
    handlers: Map<string, (...args: unknown[]) => void>
    connect: () => void
    quit: ReturnType<typeof vi.fn>
    say: ReturnType<typeof vi.fn>
    isConnected: boolean
    irc: { onAnyMessage: (fn: (...args: unknown[]) => void) => { unbind: () => void } }
  }>
}))

vi.mock('@twurple/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@twurple/chat')>()
  class FakeChatClient {
    handlers = new Map<string, (...args: unknown[]) => void>()
    connect = vi.fn()
    quit = vi.fn()
    say = vi.fn(async () => {})
    isConnected = false
    // The ircv3 client twurple exposes; only its any-message binder is used by the source.
    irc = {
      onAnyMessage: (fn: (...args: unknown[]) => void): { unbind: () => void } =>
        this.#bind('anyMessage', fn)
    }
    constructor() {
      irc.clients.push(this)
    }
    onConnect(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('connect', fn)
    }
    onJoin(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('join', fn)
    }
    onJoinFailure(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('joinFailure', fn)
    }
    onDisconnect(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('disconnect', fn)
    }
    onMessage(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('message', fn)
    }
    onMessageRemove(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('messageRemove', fn)
    }
    onSub(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('sub', fn)
    }
    onResub(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('resub', fn)
    }
    onSubGift(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('subGift', fn)
    }
    onCommunitySub(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('communitySub', fn)
    }
    onRaid(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('raid', fn)
    }
    onAnnouncement(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('announcement', fn)
    }
    onPrimePaidUpgrade(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('primePaidUpgrade', fn)
    }
    onGiftPaidUpgrade(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('giftPaidUpgrade', fn)
    }
    onStandardPayForward(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('standardPayForward', fn)
    }
    onCommunityPayForward(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('communityPayForward', fn)
    }
    onSubExtend(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('subExtend', fn)
    }
    onBitsBadgeUpgrade(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('bitsBadgeUpgrade', fn)
    }
    onTimeout(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('timeout', fn)
    }
    onBan(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('ban', fn)
    }
    onChatClear(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('chatClear', fn)
    }
    onTokenFetchFailure(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('tokenFetchFailure', fn)
    }
    onMessageFailed(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('messageFailed', fn)
    }
    onNoPermission(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('noPermission', fn)
    }
    onMessageRatelimit(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('messageRatelimit', fn)
    }
    onAuthenticationFailure(fn: (...args: unknown[]) => void): { unbind: () => void } {
      return this.#bind('authenticationFailure', fn)
    }
    #bind(event: string, fn: (...args: unknown[]) => void): { unbind: () => void } {
      this.handlers.set(event, fn)
      return { unbind: vi.fn() }
    }
  }
  return { ...actual, ChatClient: FakeChatClient }
})

// The room-id lookup (`helix/users`) goes through proxiedFetch; answer it with id 500.
const proxiedFetch = vi.hoisted(() => vi.fn())
vi.mock('@main/net/proxy', () => ({ proxiedFetch }))

const emotes = {
  ensureChannel: vi.fn(),
  whenChannelLoaded: vi.fn().mockResolvedValue(undefined),
  tokenize: (fragments: unknown): unknown => fragments,
  setTwitchChannel: vi.fn()
} as unknown as EmoteEngine

const badges = {
  ensureGlobal: vi.fn(),
  ensureChannel: vi.fn(),
  resolve: vi.fn()
} as unknown as TwitchBadgeProvider

const twitchEmotes = {
  fetchChannel: vi.fn().mockResolvedValue([])
} as unknown as TwitchEmoteProvider

function makeAuth(overrides: Record<string, unknown> = {}): TwitchAuthManager {
  const auth: Record<string, unknown> = {
    isLoggedIn: true,
    userId: 'u1',
    userName: 'modlogin',
    clientId: 'client-id',
    accessToken: vi.fn().mockResolvedValue('token'),
    getAuthProvider: () => ({}),
    handleAuthFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
  // Mirror the real helixFetch: no client id / no token → no request; otherwise the room-id lookup
  // and emote/badge providers go through the mocked proxiedFetch (id 500).
  auth['helixFetch'] ??= vi.fn(async (url: string) => {
    const token = await (auth['accessToken'] as () => Promise<string | undefined>)()
    if (auth['clientId'] === undefined || token === undefined) {
      return undefined
    }
    return proxiedFetch(url)
  })
  return auth as unknown as TwitchAuthManager
}

const loggedOutAuth = {
  isLoggedIn: false,
  userId: undefined,
  userName: undefined,
  clientId: 'client-id',
  accessToken: vi.fn().mockResolvedValue(undefined),
  getAuthProvider: () => undefined,
  helixFetch: vi.fn().mockResolvedValue(undefined)
} as unknown as TwitchAuthManager

/** What a test may vary about a source: the constructor options, the channel, the emote engine. */
interface SourceOverrides {
  twitchHistory?: () => boolean
  rawSink?: (line: string, source: 'live' | 'recent-messages') => void
  persistedStreamerKey?: string
  login?: string
  engine?: EmoteEngine
}

function makeSource(auth: TwitchAuthManager, overrides: SourceOverrides = {}): TwitchSource {
  const options: TwitchSourceOptions = {
    twitchHistory: overrides.twitchHistory ?? ((): boolean => false)
  }
  if (overrides.rawSink !== undefined) {
    options.rawSink = overrides.rawSink
  }
  if (overrides.persistedStreamerKey !== undefined) {
    options.persistedStreamerKey = overrides.persistedStreamerKey
  }
  return new TwitchSource(
    overrides.login ?? 'somechannel',
    overrides.engine ?? emotes,
    auth,
    {
      badges,
      emotes: twitchEmotes,
      cheermotes: new TwitchCheermoteProvider()
    },
    options
  )
}

const token = encodeTwitchMenuToken({ messageId: 'm1', userId: 'u9', userLogin: 'baduser' })

/** A minimal twurple ChatMessage covering the fields the onMessage path reads. */
function ircMessage(login: string): TwitchChatMessage {
  return {
    id: `msg-${login}-${Math.random()}`,
    date: new Date(1_700_000_000_000),
    emoteOffsets: new Map(),
    tags: new Map<string, string>(),
    bits: 0,
    isFirst: false,
    isHighlight: false,
    rewardId: null,
    isReply: false,
    parentMessageId: null,
    channelId: '500',
    userInfo: {
      userId: `id-${login}`,
      userName: login,
      displayName: login,
      color: undefined,
      badges: new Map(),
      isBroadcaster: false,
      isMod: false,
      isVip: false,
      isSubscriber: false,
      isFounder: false
    }
  } as unknown as TwitchChatMessage
}

/** A minimal USERNOTICE (sub/gift events) covering the fields the sub-event path reads. */
function subNotice(login: string, tags: Record<string, string> = {}): Record<string, unknown> {
  return {
    id: `notice-${login}-${Math.random()}`,
    date: new Date(1_700_000_000_000),
    emoteOffsets: new Map(),
    tags: new Map(Object.entries(tags)),
    userInfo: {
      userId: `id-${login}`,
      userName: login,
      displayName: login,
      color: undefined,
      badges: new Map(),
      isBroadcaster: false,
      isMod: false,
      isVip: false,
      isSubscriber: false,
      isFounder: false
    }
  }
}

/** Connect a source against the fake IRC client and return that client. */
async function connectSource(source: TwitchSource): Promise<(typeof irc.clients)[number]> {
  await source.connect()
  const client = irc.clients.at(-1)
  if (client === undefined) {
    throw new Error('connect() did not construct a ChatClient')
  }
  return client
}

beforeEach(() => {
  helix.asUser.mockClear()
  helix.deleteChatMessages.mockReset()
  helix.banUser.mockReset()
  helix.getModeratedChannels.mockReset()
  helix.getStreamByUserName.mockReset()
  helix.getStreamByUserName.mockResolvedValue(null)
  helix.getUserById.mockReset()
  helix.getUsersByNames.mockReset()
  helix.getUsersByNames.mockResolvedValue([])
  irc.clients.length = 0
  proxiedFetch.mockReset()
  proxiedFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: '500' }] }) })
})

afterEach(() => {
  vi.useRealTimers()
})

/** One raw backlog PRIVMSG, as the recent-messages service serves them. */
const BACKLOG_LINE =
  '@badge-info=;badges=;color=;display-name=Alice;emotes=;flags=;id=backlog-1;mod=0;room-id=500;' +
  'subscriber=0;tmi-sent-ts=1700000000000;turbo=0;user-id=100;user-type= ' +
  ':alice!alice@alice.tmi.twitch.tv PRIVMSG #somechannel :hello poggers'

/** The channel emote the fake engine splices in once its catalog has loaded. */
const CHANNEL_EMOTE = {
  type: 'emote',
  code: 'poggers',
  url: 'https://cdn/poggers.png',
  provider: '7tv'
}

/** Answer the recent-messages fetch with `lines`; every other call still resolves the room id. */
function serveBacklog(lines: string[]): void {
  proxiedFetch.mockImplementation((url: unknown) =>
    typeof url === 'string' && url.includes('recent-messages.robotty.de')
      ? Promise.resolve({ ok: true, json: async () => ({ messages: lines }) })
      : Promise.resolve({ ok: true, json: async () => ({ data: [{ id: '500' }] }) })
  )
}

/**
 * An emote engine whose channel catalog lands after `loadMs`, and which only tokenizes the channel
 * emote once it has — so a backlog row shows whether it waited.
 */
function lateLoadingEngine(loadMs: number): EmoteEngine {
  let loaded = false
  return {
    ensureChannel: vi.fn(),
    whenChannelLoaded: vi.fn(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, loadMs))
      loaded = true
    }),
    tokenize: (fragments: unknown): unknown => (loaded ? [CHANNEL_EMOTE] : fragments),
    setTwitchChannel: vi.fn()
  } as unknown as EmoteEngine
}

describe('TwitchSource recent-messages history', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const historyCalls = (): unknown[] =>
    proxiedFetch.mock.calls.filter((call) => String(call[0]).includes('recent-messages.robotty.de'))

  it('fetches the recent-messages backlog on connect when history is enabled', async () => {
    const source = makeSource(loggedOutAuth, { twitchHistory: () => true })
    await connectSource(source)
    await flush()
    expect(historyCalls()).toHaveLength(1)
    expect(String(historyCalls()[0])).toContain('/recent-messages/somechannel?limit=100')
  })

  it('does not fetch history when the setting is off', async () => {
    const source = makeSource(loggedOutAuth, { twitchHistory: () => false })
    await connectSource(source)
    await flush()
    expect(historyCalls()).toHaveLength(0)
  })

  it("waits for the channel's emotes so the backlog tokenizes with them", async () => {
    vi.useFakeTimers()
    serveBacklog([BACKLOG_LINE])
    const source = makeSource(makeAuth(), {
      twitchHistory: () => true,
      engine: lateLoadingEngine(1_000)
    })
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    await connectSource(source)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.backlog).toBe(true)
    // Without the wait this row would have been tokenized against the global set only, and never
    // re-tokenized — the channel emote would be missing from the whole backlog for good.
    expect(messages[0]?.fragments).toEqual([CHANNEL_EMOTE])
    await source.disconnect()
  })

  it('emits the backlog on the cap when the emote load stalls', async () => {
    vi.useFakeTimers()
    serveBacklog([BACKLOG_LINE])
    const source = makeSource(makeAuth(), {
      twitchHistory: () => true,
      engine: lateLoadingEngine(10_000)
    })
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    await connectSource(source)

    await vi.advanceTimersByTimeAsync(2_900)
    expect(messages).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    expect(messages).toHaveLength(1)
    // The catalog still hasn't landed, so the row renders with plain text rather than waiting on.
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: 'hello poggers' }])
    await source.disconnect()
  })
})

describe('TwitchSource raw line sink', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('feeds every raw IRC line to the sink, live and from the backlog', async () => {
    serveBacklog([BACKLOG_LINE])
    const seen: Array<[string, string]> = []
    const source = makeSource(makeAuth(), {
      twitchHistory: () => true,
      rawSink: (line, origin) => seen.push([line, origin])
    })
    const client = await connectSource(source)
    const anyMessage = client.handlers.get('anyMessage')
    anyMessage?.({
      rawLine: ':alice!alice@alice.tmi.twitch.tv PRIVMSG #somechannel :hi',
      tags: new Map()
    })
    anyMessage?.({
      rawLine: '@ban-duration=10 :tmi.twitch.tv CLEARCHAT #somechannel :baduser',
      tags: new Map()
    })
    // A line ircv3 parsed without keeping its source text has nothing to capture.
    anyMessage?.({ rawLine: undefined, tags: new Map() })
    for (let i = 0; i < 5; i++) {
      await flush()
    }

    expect(seen.filter(([, origin]) => origin === 'live')).toEqual([
      [':alice!alice@alice.tmi.twitch.tv PRIVMSG #somechannel :hi', 'live'],
      ['@ban-duration=10 :tmi.twitch.tv CLEARCHAT #somechannel :baduser', 'live']
    ])
    expect(seen.filter(([, origin]) => origin === 'recent-messages')).toEqual([
      [BACKLOG_LINE, 'recent-messages']
    ])
    await source.disconnect()
  })
})

describe('TwitchSource anonymous gift-sub upgrade', () => {
  it('emits one system line for the USERNOTICE twurple parses no event for', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    const anyMessage = client.handlers.get('anyMessage')
    anyMessage?.({
      rawLine:
        '@msg-id=anongiftpaidupgrade;id=notice-1;login=viewer_one;display-name=Viewer_One;user-id=200000001 :tmi.twitch.tv USERNOTICE #somechannel',
      command: 'USERNOTICE',
      tags: new Map([
        ['msg-id', 'anongiftpaidupgrade'],
        ['id', 'notice-1'],
        ['login', 'viewer_one'],
        ['display-name', 'Viewer_One'],
        ['user-id', '200000001']
      ])
    })
    // Every other USERNOTICE reaches the column through twurple's own typed events; picking them
    // up here too would double every sub, gift and raid.
    anyMessage?.({
      rawLine: '@msg-id=sub;id=notice-2 :tmi.twitch.tv USERNOTICE #somechannel',
      command: 'USERNOTICE',
      tags: new Map([
        ['msg-id', 'sub'],
        ['id', 'notice-2']
      ])
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('notice-1')
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.highlight).toBeUndefined()
    expect(messages[0]?.author.displayName).toBe('Viewer_One')
    expect(messages[0]?.author.id).toBe('200000001')
    expect(messages[0]?.menuToken).toBeUndefined()
    expect(messages[0]?.fragments).toEqual([
      {
        type: 'text',
        text: 'Viewer_One is continuing the gift sub they got from an anonymous user'
      }
    ])
    await source.disconnect()
  })

  it('falls back to a synthetic id when the notice carries none', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('anyMessage')?.({
      rawLine: '@msg-id=anongiftpaidupgrade :tmi.twitch.tv USERNOTICE #somechannel',
      command: 'USERNOTICE',
      tags: new Map([['msg-id', 'anongiftpaidupgrade']])
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toMatch(/^anon-upgrade-twitch:somechannel-/u)
    await source.disconnect()
  })
})

describe('TwitchSource.streamerKey', () => {
  it('normalises the target login', () => {
    expect(makeSource(makeAuth(), { login: 'Some_Login' }).streamerKey()).toBe('some_login')
  })

  it('keeps the key the column was already stored under', () => {
    const source = makeSource(makeAuth(), {
      login: 'Some_Login',
      persistedStreamerKey: 'formername'
    })
    expect(source.streamerKey()).toBe('formername')
  })
})

describe('TwitchSource.getMessageActions role gating', () => {
  it('returns no actions when logged out', async () => {
    const source = makeSource(loggedOutAuth)
    await expect(source.getMessageActions(token)).resolves.toEqual([])
    expect(proxiedFetch).not.toHaveBeenCalled()
  })

  it('offers remove/timeout/ban to the broadcaster without a Helix role lookup', async () => {
    const source = makeSource(makeAuth({ userName: 'SomeChannel' }))
    const actions = await source.getMessageActions(token)
    expect(actions.map((action) => action.id)).toEqual(['remove', 'timeout', 'ban'])
    expect(actions.every((action) => action.destructive)).toBe(true)
    expect(actions[1]?.timeoutDurations).toEqual([10, 60, 600, 1800, 3600, 86400])
    expect(helix.getModeratedChannels).not.toHaveBeenCalled()
  })

  it('offers the actions to a moderator and caches the role check', async () => {
    helix.getModeratedChannels.mockResolvedValue([{ id: '123' }, { id: '500' }])
    const source = makeSource(makeAuth())
    const actions = await source.getMessageActions(token)
    expect(actions.map((action) => action.id)).toEqual(['remove', 'timeout', 'ban'])
    await source.getMessageActions(token)
    expect(helix.getModeratedChannels).toHaveBeenCalledTimes(1)
  })

  it('returns no actions for a non-moderator', async () => {
    helix.getModeratedChannels.mockResolvedValue([{ id: '123' }])
    const source = makeSource(makeAuth())
    await expect(source.getMessageActions(token)).resolves.toEqual([])
  })

  it('returns no actions (and does not cache) when the role lookup fails', async () => {
    helix.getModeratedChannels.mockRejectedValueOnce(
      Object.assign(new Error('401'), {
        statusCode: 401
      })
    )
    helix.getModeratedChannels.mockResolvedValueOnce([{ id: '500' }])
    const source = makeSource(makeAuth())
    await expect(source.getMessageActions(token)).resolves.toEqual([])
    // The failed check wasn't cached: the next open re-asks Helix and finds the role.
    const retried = await source.getMessageActions(token)
    expect(retried.map((action) => action.id)).toEqual(['remove', 'timeout', 'ban'])
  })

  it('returns no actions for a malformed token', async () => {
    const source = makeSource(makeAuth({ userName: 'somechannel' }))
    await expect(source.getMessageActions('not json')).resolves.toEqual([])
  })

  it('surfaces one re-login notice per connect when the mod check is rejected as unauthorized', async () => {
    helix.getModeratedChannels.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    )
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    await connectSource(source)
    await expect(source.getMessageActions(token)).resolves.toEqual([])
    await expect(source.getMessageActions(token)).resolves.toEqual([])
    const notices = messages.filter((message) => message.system === true)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.fragments[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('log out and back in to Twitch') as string
    })
    await source.disconnect()
  })

  it('stays silent when the mod check fails for a non-auth reason', async () => {
    helix.getModeratedChannels.mockRejectedValue(new Error('network down'))
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    await connectSource(source)
    await expect(source.getMessageActions(token)).resolves.toEqual([])
    expect(messages).toEqual([])
    await source.disconnect()
  })
})

describe('TwitchSource.send', () => {
  it('rejects when logged out', async () => {
    const source = makeSource(loggedOutAuth)
    await expect(source.send('hello')).rejects.toThrow('Log in to Twitch to send messages')
  })

  it('rejects fast when the IRC client is not connected, leaving the message unsent', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = false
    await expect(source.send('hello')).rejects.toThrow('Not connected to Twitch — message not sent')
    expect(client.say).not.toHaveBeenCalled()
    await source.disconnect()
  })

  it('says the message (with the reply parent) and echoes it under the numeric user id', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.isConnected = true
    await source.send('hello chat')
    await source.send('hi again', {
      parentId: 'parent-msg-id',
      parentAuthor: 'Bob',
      parentText: 'hello',
      threadId: 'root-id',
      threadAuthor: 'Streamer'
    })
    expect(client.say).toHaveBeenNthCalledWith(1, 'somechannel', 'hello chat', undefined)
    expect(client.say).toHaveBeenNthCalledWith(2, 'somechannel', 'hi again', {
      replyTo: 'parent-msg-id'
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.self).toBe(true)
    expect(messages[0]?.author.id).toBe('u1')
    expect(messages[0]?.author.name).toBe('modlogin')
    // The echoed reply carries the thread context so it renders threaded (Twitch echoes nothing back).
    expect(messages[1]?.reply).toEqual({
      parentId: 'parent-msg-id',
      parentAuthor: 'Bob',
      parentText: 'hello',
      threadId: 'root-id',
      threadAuthor: 'Streamer'
    })
    await source.disconnect()
  })

  it('splits an over-long message into within-limit parts with every emoji intact', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = true
    // Long enough to need splitting, with the emoji straddling the 500-code-unit cut: twurple's own
    // splitter would slice mid-surrogate-pair here and post two `�` halves.
    const text = 'x'.repeat(497) + '🎉'.repeat(30)
    await source.send(text)

    const sent = client.say.mock.calls.map((call: unknown[]) => call[1] as string)
    expect(sent.length).toBeGreaterThan(1)
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(500)
      expect(part).not.toMatch(/[\uD800-\uDFFF]/u) // no lone surrogate survived the split
    }
    expect(sent.join('')).toContain('🎉'.repeat(30))
    await source.disconnect()
  })

  it('refuses a whitespace-only message instead of reporting success without sending', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = true
    // The splitter trims every part away, leaving nothing to send — that must surface as an error,
    // not as a silent success the caller mistakes for a delivered message.
    await expect(source.send(' '.repeat(600))).rejects.toThrow('nothing to send')
    expect(client.say).not.toHaveBeenCalled()
    await source.disconnect()
  })

  it('names how much got through when a later part of a split message fails', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = true
    client.say.mockReset()
    client.say.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('rate limited'))
    // The composer refills with the whole draft, so a bare failure would invite a resend that
    // duplicates the part already in the channel.
    await expect(source.send(`${'a'.repeat(10)} ${'b'.repeat(980)}`)).rejects.toThrow(
      /Sent 1 of 3 parts/u
    )
    await source.disconnect()
  })

  it('stops sending the remaining parts once the connection drops mid-message', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = true
    client.say.mockReset()
    client.say.mockImplementation(() => {
      client.isConnected = false // the socket goes away after the first part
      return Promise.resolve(undefined)
    })
    await expect(source.send('a'.repeat(1200))).rejects.toThrow(/connection dropped/u)
    expect(client.say).toHaveBeenCalledTimes(1)
    await source.disconnect()
  })

  it('does not split a message that already fits', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.isConnected = true
    await source.send('just a normal 🎉 message')
    expect(client.say).toHaveBeenCalledTimes(1)
    expect(client.say).toHaveBeenCalledWith('somechannel', 'just a normal 🎉 message', undefined)
    await source.disconnect()
  })

  it('times out a say() that never settles instead of hanging, and emits no echo', async () => {
    vi.useFakeTimers()
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.isConnected = true
    client.say.mockReturnValue(new Promise(() => {}))
    const assertion = expect(source.send('hello chat')).rejects.toThrow(
      'Twitch send timed out — message not sent'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(messages).toEqual([])
    await source.disconnect()
  })

  it('echoes a message that twurple delivered after the timeout already reported a failure', async () => {
    vi.useFakeTimers()
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.isConnected = true
    let deliver!: () => void
    client.say.mockReturnValue(
      new Promise<void>((resolve) => {
        deliver = resolve
      })
    )
    const assertion = expect(source.send('held by the limiter')).rejects.toThrow(
      'Twitch send timed out — message not sent'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(messages).toEqual([])

    // The rate limiter drains and the line goes out after all: surface it so the user
    // doesn't resend a duplicate.
    deliver()
    await vi.advanceTimersByTimeAsync(0)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.self).toBe(true)
    expect(messages[0]?.fragments).toEqual([{ type: 'text', text: 'held by the limiter' }])
    await source.disconnect()
  })

  it('swallows a say() rejection that loses the race, instead of an unhandled rejection', async () => {
    vi.useFakeTimers()
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.isConnected = true
    let fail!: (error: Error) => void
    client.say.mockReturnValue(
      new Promise<void>((_, reject) => {
        fail = reject
      })
    )
    const assertion = expect(source.send('dropped on reconnect')).rejects.toThrow(
      'Twitch send timed out — message not sent'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion

    // The abandoned say() rejects late: no echo, and no unhandledRejection (which vitest
    // would surface as a test error).
    fail(new Error('queue dropped'))
    await vi.advanceTimersByTimeAsync(0)
    expect(messages).toEqual([])
    await source.disconnect()
  })
})

describe('TwitchSource moderation clears', () => {
  it('emits a by-user clear for a ban and a timeout', async () => {
    const source = makeSource(makeAuth())
    const clears: ClearTarget[] = []
    source.on('clear', (target) => clears.push(target))
    const client = await connectSource(source)
    client.handlers.get('ban')?.('#somechannel', 'baduser', { targetUserId: 'u9' })
    client.handlers.get('timeout')?.('#somechannel', 'baduser', 600, { targetUserId: 'u9' })
    expect(clears).toEqual([{ userId: 'u9' }, { userId: 'u9' }])
    await source.disconnect()
  })

  it('emits a whole-chat clear for CLEARCHAT without a target user', async () => {
    const source = makeSource(makeAuth())
    const clears: ClearTarget[] = []
    source.on('clear', (target) => clears.push(target))
    const client = await connectSource(source)
    client.handlers.get('chatClear')?.('#somechannel', { targetUserId: null })
    expect(clears).toEqual([{}])
    await source.disconnect()
  })

  it('ignores clears for other channels and bans without a target id', async () => {
    const source = makeSource(makeAuth())
    const clears: ClearTarget[] = []
    source.on('clear', (target) => clears.push(target))
    const client = await connectSource(source)
    client.handlers.get('ban')?.('#otherchannel', 'baduser', { targetUserId: 'u9' })
    client.handlers.get('timeout')?.('#otherchannel', 'baduser', 60, { targetUserId: 'u9' })
    client.handlers.get('chatClear')?.('#otherchannel', { targetUserId: null })
    client.handlers.get('ban')?.('#somechannel', 'baduser', { targetUserId: null })
    expect(clears).toEqual([])
    await source.disconnect()
  })
})

describe('TwitchSource disconnect and auth status', () => {
  it('reports an error when twurple quits on its own (not via disconnect())', async () => {
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.handlers.get('disconnect')?.(true, undefined)
    expect(source.status()).toEqual({
      state: 'error',
      message: 'Twitch closed the connection — try logging in again'
    })
    await source.disconnect()
  })

  it('surfaces a token fetch failure and keeps it across the internal quit', async () => {
    const handleAuthFailure = vi.fn().mockResolvedValue(undefined)
    const source = makeSource(makeAuth({ handleAuthFailure }))
    const client = await connectSource(source)
    client.handlers.get('tokenFetchFailure')?.(new Error('refresh token revoked'))
    expect(handleAuthFailure).toHaveBeenCalledTimes(1)
    client.handlers.get('disconnect')?.(true, undefined)
    expect(source.status()).toEqual({
      state: 'error',
      message: 'Twitch auth failed: refresh token revoked'
    })
    await source.disconnect()
  })

  it('reports offline after an intentional disconnect()', async () => {
    const source = makeSource(makeAuth())
    await connectSource(source)
    await source.disconnect()
    expect(source.status()).toEqual({ state: 'offline' })
  })

  it("re-quits the orphaned client past twurple's longest auth-retry delay, repeatedly but bounded", async () => {
    vi.useFakeTimers()
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    await source.disconnect()
    expect(client.quit).toHaveBeenCalledTimes(1)

    // The internal auth-retry is a chain, so one re-quit can miss a revival mid-delay:
    // re-quit on every 125s interval tick…
    await vi.advanceTimersByTimeAsync(125_000)
    expect(client.quit).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4 * 125_000)
    expect(client.quit).toHaveBeenCalledTimes(6)

    // …but a bounded number of times, so a removed channel doesn't tick forever.
    await vi.advanceTimersByTimeAsync(10 * 125_000)
    expect(client.quit).toHaveBeenCalledTimes(6)
  })
})

describe('TwitchSource.runMessageAction', () => {
  it('removes a message via deleteChatMessages as the logged-in user', async () => {
    const source = makeSource(makeAuth())
    await source.runMessageAction(token, 'remove')
    expect(helix.asUser).toHaveBeenCalledWith('u1')
    expect(helix.deleteChatMessages).toHaveBeenCalledWith('500', 'm1')
  })

  it('times out via banUser with the chosen duration', async () => {
    const source = makeSource(makeAuth())
    await source.runMessageAction(token, 'timeout', 600)
    expect(helix.banUser).toHaveBeenCalledWith('500', { user: 'u9', duration: 600 })
  })

  it('bans via banUser without a duration', async () => {
    const source = makeSource(makeAuth())
    await source.runMessageAction(token, 'ban')
    expect(helix.banUser).toHaveBeenCalledWith('500', { user: 'u9' })
  })

  it('requires a duration for a timeout', async () => {
    const source = makeSource(makeAuth())
    await expect(source.runMessageAction(token, 'timeout')).rejects.toThrow(
      'Pick a timeout duration'
    )
    expect(helix.banUser).not.toHaveBeenCalled()
  })

  it('rejects when logged out', async () => {
    const source = makeSource(loggedOutAuth)
    await expect(source.runMessageAction(token, 'remove')).rejects.toThrow('Log in to Twitch')
  })

  it('rejects an unknown action id without calling Helix', async () => {
    const source = makeSource(makeAuth())
    await expect(source.runMessageAction(token, 'explode')).rejects.toThrow(
      'Unknown Twitch chat action'
    )
    expect(helix.asUser).not.toHaveBeenCalled()
  })

  it('tells the user to re-login when Helix rejects with 403 (missing scopes)', async () => {
    helix.banUser.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }))
    const source = makeSource(makeAuth())
    await expect(source.runMessageAction(token, 'ban')).rejects.toThrow(
      /log out and back in to Twitch/
    )
  })

  it('surfaces other Helix failures with the action and target named', async () => {
    helix.deleteChatMessages.mockRejectedValue(new Error('the network fell over'))
    const source = makeSource(makeAuth())
    await expect(source.runMessageAction(token, 'remove')).rejects.toThrow(
      'Twitch remove message for baduser failed: the network fell over'
    )
  })
})

describe('TwitchSource stream-live poll', () => {
  it('flips connected → live(viewers) → connected across polls and stops on disconnect', async () => {
    vi.useFakeTimers()
    const source = makeSource(makeAuth())
    const statuses: SourceStatus[] = []
    source.on('status', (status) => statuses.push(status))
    const client = await connectSource(source)
    await vi.advanceTimersByTimeAsync(0) // immediate first poll: not live
    client.handlers.get('connect')?.()
    expect(source.status()).toEqual({ state: 'connected' })

    helix.getStreamByUserName.mockResolvedValueOnce({ viewers: 123 })
    await vi.advanceTimersByTimeAsync(65_000)
    expect(source.status()).toEqual({ state: 'live', viewers: 123 })

    // Unchanged viewers emit no duplicate status event.
    helix.getStreamByUserName.mockResolvedValueOnce({ viewers: 123 })
    const emitted = statuses.length
    await vi.advanceTimersByTimeAsync(65_000)
    expect(statuses.length).toBe(emitted)

    // Changed viewers do.
    helix.getStreamByUserName.mockResolvedValueOnce({ viewers: 200 })
    await vi.advanceTimersByTimeAsync(65_000)
    expect(source.status()).toEqual({ state: 'live', viewers: 200 })

    await vi.advanceTimersByTimeAsync(65_000) // default mock: stream over
    expect(source.status()).toEqual({ state: 'connected' })

    await source.disconnect()
    const polls = helix.getStreamByUserName.mock.calls.length
    // Past the live-poll cadence AND the bounded orphan re-quit interval (5 × 125s).
    await vi.advanceTimersByTimeAsync(700_000)
    expect(helix.getStreamByUserName.mock.calls.length).toBe(polls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never polls Helix when logged out (status stays plain connected)', async () => {
    vi.useFakeTimers()
    const source = makeSource(loggedOutAuth)
    const client = await connectSource(source)
    client.handlers.get('connect')?.()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(helix.getStreamByUserName).not.toHaveBeenCalled()
    expect(source.status()).toEqual({ state: 'connected' })
  })

  it('does not clobber an error status from a join failure', async () => {
    vi.useFakeTimers()
    helix.getStreamByUserName.mockResolvedValue({ viewers: 7 })
    const source = makeSource(makeAuth())
    const client = await connectSource(source)
    client.handlers.get('joinFailure')?.('#somechannel', 'msg_banned')
    await vi.advanceTimersByTimeAsync(65_000)
    expect(source.status()).toEqual({ state: 'error', message: 'Join failed: msg_banned' })
    await source.disconnect()
  })
})

describe('TwitchSource chatter avatars', () => {
  it('batch-resolves a login once and attaches the avatar only to later messages', async () => {
    vi.useFakeTimers()
    helix.getUsersByNames.mockResolvedValue([
      { name: 'alice', profilePictureUrl: 'https://cdn/alice.png' }
    ])
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    const deliver = client.handlers.get('message')
    deliver?.('#somechannel', 'alice', 'hi', ircMessage('alice'))
    deliver?.('#somechannel', 'alice', 'hi again', ircMessage('alice'))
    // Messages before the batch resolves stay bare.
    expect(messages[0]?.author.avatarUrl).toBeUndefined()
    expect(messages[1]?.author.avatarUrl).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(helix.getUsersByNames).toHaveBeenCalledTimes(1)
    expect(helix.getUsersByNames).toHaveBeenCalledWith(['alice'])
    deliver?.('#somechannel', 'alice', 'later', ircMessage('alice'))
    expect(messages[2]?.author.avatarUrl).toBe('https://cdn/alice.png')
    await source.disconnect()
  })

  it('never looks up avatars when logged out', async () => {
    vi.useFakeTimers()
    const source = makeSource(loggedOutAuth)
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('message')?.('#somechannel', 'alice', 'hi', ircMessage('alice'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(helix.getUsersByNames).not.toHaveBeenCalled()
    expect(messages[0]?.author.avatarUrl).toBeUndefined()
  })
})

describe('TwitchSource.getUserProfile', () => {
  it('maps the Helix user onto the profile', async () => {
    helix.getUserById.mockResolvedValue({
      id: 'u9',
      name: 'baduser',
      displayName: 'BadUser',
      profilePictureUrl: 'https://cdn/baduser.png',
      description: 'chatting badly',
      creationDate: new Date(1_600_000_000_000)
    })
    const source = makeSource(makeAuth())
    await expect(source.getUserProfile('u9')).resolves.toStrictEqual({
      platform: 'twitch',
      userId: 'u9',
      displayName: 'BadUser',
      handle: 'baduser',
      avatarUrl: 'https://cdn/baduser.png',
      url: 'https://www.twitch.tv/baduser',
      createdAt: 1_600_000_000_000,
      description: 'chatting badly'
    })
    expect(helix.getUserById).toHaveBeenCalledWith('u9')
  })

  it('omits the avatar and description keys when Helix returns them empty', async () => {
    helix.getUserById.mockResolvedValue({
      id: 'u9',
      name: 'baduser',
      displayName: 'BadUser',
      profilePictureUrl: '',
      description: '',
      creationDate: new Date(1_600_000_000_000)
    })
    const source = makeSource(makeAuth())
    await expect(source.getUserProfile('u9')).resolves.toStrictEqual({
      platform: 'twitch',
      userId: 'u9',
      displayName: 'BadUser',
      handle: 'baduser',
      url: 'https://www.twitch.tv/baduser',
      createdAt: 1_600_000_000_000
    })
  })

  it('returns undefined when logged out, without calling Helix', async () => {
    const source = makeSource(loggedOutAuth)
    await expect(source.getUserProfile('u9')).resolves.toBeUndefined()
    expect(helix.getUserById).not.toHaveBeenCalled()
  })

  it('returns undefined for an unknown user or a failed lookup', async () => {
    helix.getUserById.mockResolvedValueOnce(null)
    const source = makeSource(makeAuth())
    await expect(source.getUserProfile('u9')).resolves.toBeUndefined()
    helix.getUserById.mockRejectedValueOnce(new Error('helix down'))
    await expect(source.getUserProfile('u9')).resolves.toBeUndefined()
  })
})

describe('TwitchSource sub events', () => {
  it('emits subscription cards for subs and resubs', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('sub')?.(
      '#somechannel',
      'alice',
      { userId: 'id-alice', displayName: 'alice', plan: '1000', planName: 'T1', months: 1 },
      subNotice('alice')
    )
    client.handlers.get('resub')?.(
      '#somechannel',
      'bob',
      {
        userId: 'id-bob',
        displayName: 'bob',
        plan: 'Prime',
        planName: 'Prime',
        months: 13,
        message: 'a year already'
      },
      subNotice('bob')
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]?.highlight).toEqual({
      kind: 'subscription',
      headerText: 'subscribed',
      tier: 'Tier 1'
    })
    expect(messages[1]?.highlight).toEqual({
      kind: 'subscription',
      headerText: 'resubscribed',
      tier: 'Prime',
      count: 13
    })
    expect(messages[1]?.fragments).toEqual([{ type: 'text', text: 'a year already' }])
    await source.disconnect()
  })

  it('emits one line for a community gift and swallows its tagged per-recipient notices', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    const gift = (recipient: string, tags: Record<string, string>): void => {
      client.handlers.get('subGift')?.(
        '#somechannel',
        recipient,
        {
          userId: `id-${recipient}`,
          displayName: recipient,
          plan: '1000',
          planName: 'T1',
          months: 1,
          giftDuration: 1,
          gifterUserId: 'id-gifter',
          gifter: 'gifter',
          gifterDisplayName: 'Gifter'
        },
        subNotice('gifter', tags)
      )
    }
    client.handlers.get('communitySub')?.(
      '#somechannel',
      'gifter',
      { count: 2, plan: '1000', gifterUserId: 'id-gifter', gifterDisplayName: 'Gifter' },
      subNotice('gifter', { 'msg-param-community-gift-id': 'batch-1' })
    )
    gift('rec1', { 'msg-param-community-gift-id': 'batch-1' })
    gift('rec2', { 'msg-param-community-gift-id': 'batch-1' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.highlight).toEqual({
      kind: 'membership_gift',
      count: 2,
      tier: 'Tier 1',
      headerText: 'is gifting 2 Tier 1 subs to the community'
    })
    // A genuine standalone gift from the same gifter carries its own gift id and shows —
    // even with the batch only partially delivered (the failure mode of count-based dedup).
    gift('rec3', { 'msg-param-community-gift-id': 'solo-1' })
    expect(messages).toHaveLength(2)
    expect(messages[1]?.highlight?.headerText).toBe('gifted a Tier 1 sub to rec3')
    await source.disconnect()
  })

  it('keeps anonymous and untagged standalone gifts visible during a batch', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('communitySub')?.(
      '#somechannel',
      'gifter',
      { count: 1, plan: '1000', gifterUserId: 'id-gifter' },
      subNotice('gifter', { 'msg-param-community-gift-id': 'batch-1' })
    )
    client.handlers.get('subGift')?.(
      '#somechannel',
      'rec1',
      {
        userId: 'id-rec1',
        displayName: 'rec1',
        plan: '1000',
        planName: 'T1',
        months: 1,
        giftDuration: 1
      },
      subNotice('ananonymousgifter', { 'msg-param-community-gift-id': 'anon-solo' })
    )
    expect(messages).toHaveLength(2)
    expect(messages[1]?.highlight?.headerText).toBe('gifted a Tier 1 sub to rec1')
    // Anonymous gifts render a human label without a moderation menu (the notice author is
    // Twitch's shared AnAnonymousGifter service account).
    expect(messages[1]?.author.displayName).toBe('Anonymous')
    expect(messages[1]?.menuToken).toBeUndefined()
    await source.disconnect()
  })

  it('offers sub/gift cards only the user-targeted moderation actions', async () => {
    const source = makeSource(makeAuth({ userName: 'somechannel' }))
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('sub')?.(
      '#somechannel',
      'alice',
      { userId: 'id-alice', displayName: 'alice', plan: '1000', planName: 'T1', months: 1 },
      subNotice('alice')
    )
    const cardToken = messages[0]?.menuToken ?? ''
    const actions = await source.getMessageActions(cardToken)
    // No 'remove': Helix cannot delete USERNOTICEs, so the action would always fail.
    expect(actions.map((action) => action.id)).toEqual(['timeout', 'ban'])
    await source.disconnect()
  })
})

describe('TwitchSource channel-points reward back-fill', () => {
  it('back-fills a reward name via replace once the catalog loads after the redemption', async () => {
    let resolveCatalog: (value: { ok: true; json: () => Promise<unknown> }) => void = () => {}
    const catalog = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveCatalog = resolve
    })
    // The reward catalog (GraphQL) stays pending until we resolve it; everything else answers id 500.
    proxiedFetch.mockImplementation((url: unknown) =>
      typeof url === 'string' && url.includes('gql.twitch.tv')
        ? catalog
        : Promise.resolve({ ok: true, json: async () => ({ data: [{ id: '500' }] }) })
    )
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    const replaced: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    source.on('replace', (message) => replaced.push(message))
    const client = await connectSource(source)

    const redemption = ircMessage('alice')
    ;(redemption as { rewardId: string | null }).rewardId = 'reward-uuid'
    client.handlers.get('message')?.('#somechannel', 'alice', 'redeemed text', redemption)
    // Emitted immediately with the reward id but no name yet — the catalog is still loading.
    expect(messages.at(-1)?.reward).toEqual({ id: 'reward-uuid' })
    expect(replaced).toHaveLength(0)

    resolveCatalog({
      ok: true,
      json: async () => ({
        data: {
          user: {
            channel: {
              communityPointsSettings: {
                customRewards: [{ id: 'reward-uuid', title: 'Hydrate!' }]
              }
            }
          }
        }
      })
    })
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    // The catalog resolved, so the redemption is re-emitted with its title via a replace.
    expect(replaced.at(-1)?.reward).toEqual({ id: 'reward-uuid', name: 'Hydrate!' })
    await source.disconnect()
  })

  it('does not let a superseded catalog load clear a reconnect’s pending back-fill (FFR-1)', async () => {
    function deferred(): {
      promise: Promise<{ ok: boolean; json: () => Promise<unknown> }>
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void
    } {
      let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void
      const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }
    const first = deferred()
    const second = deferred()
    let gqlCalls = 0
    proxiedFetch.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.includes('gql.twitch.tv')) {
        gqlCalls += 1
        return gqlCalls === 1 ? first.promise : second.promise
      }
      return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: '500' }] }) })
    })
    const source = makeSource(makeAuth())
    const replaced: ChatMessage[] = []
    source.on('replace', (message) => replaced.push(message))

    // First connect starts catalog load #1; a reconnect on the same source starts load #2 (load #1
    // hasn't cached yet, so the provider fetches again).
    await connectSource(source)
    await source.disconnect()
    const client = await connectSource(source)

    const redemption = ircMessage('alice')
    ;(redemption as { rewardId: string | null }).rewardId = 'reward-uuid'
    client.handlers.get('message')?.('#somechannel', 'alice', 'redeemed text', redemption)

    // The OLD load fails and resolves first — its stale flush must not drain the new pending queue.
    first.resolve({ ok: false, json: async () => ({}) })
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(replaced).toHaveLength(0)

    // The new load succeeds: the still-pending redemption is back-filled with its title.
    second.resolve({
      ok: true,
      json: async () => ({
        data: {
          user: {
            channel: {
              communityPointsSettings: { customRewards: [{ id: 'reward-uuid', title: 'Hydrate!' }] }
            }
          }
        }
      })
    })
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(replaced.at(-1)?.reward).toEqual({ id: 'reward-uuid', name: 'Hydrate!' })
    await source.disconnect()
  })
})

describe('TwitchSource notice events', () => {
  it('emits a system line for an incoming raid', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('raid')?.(
      '#somechannel',
      'raider',
      { displayName: 'Raider', viewerCount: 50 },
      subNotice('raider')
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'Raider is raiding with 50 viewers' }
    ])
    await source.disconnect()
  })

  it('emits a system line for an announcement, carrying its body', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('announcement')?.(
      '#somechannel',
      'mod',
      { color: 'PRIMARY' },
      { ...subNotice('mod'), text: 'stream starting soon' }
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.fragments[0]).toEqual({ type: 'text', text: '📣 mod: ' })
    expect(messages[0]?.fragments[1]).toEqual({ type: 'text', text: 'stream starting soon' })
    await source.disconnect()
  })

  it('emits a system line for a sub-extend (the minor notice family)', async () => {
    const source = makeSource(makeAuth())
    const messages: ChatMessage[] = []
    source.on('message', (message) => messages.push(message))
    const client = await connectSource(source)
    client.handlers.get('subExtend')?.(
      '#somechannel',
      'carol',
      { userId: 'id-carol', displayName: 'Carol', plan: '1000', months: 7, endMonth: 9 },
      subNotice('carol')
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.fragments).toEqual([
      { type: 'text', text: 'Carol extended their subscription (7 months)' }
    ])
    await source.disconnect()
  })
})
