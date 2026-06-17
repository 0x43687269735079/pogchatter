import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage as TwitchChatMessage } from '@twurple/chat'
import type { ChatMessage, ClearTarget, SourceStatus } from '@shared/model'
import type { EmoteEngine } from '@main/emotes/EmoteEngine'
import type { TwitchAuthManager } from '@main/sources/twitch/TwitchAuthManager'
import type { TwitchBadgeProvider } from '@main/sources/twitch/TwitchBadgeProvider'
import { TwitchCheermoteProvider } from '@main/sources/twitch/TwitchCheermoteProvider'
import type { TwitchEmoteProvider } from '@main/sources/twitch/TwitchEmoteProvider'
import { encodeTwitchMenuToken } from '@main/sources/twitch/normalize'
import { TwitchSource } from '@main/sources/twitch/TwitchSource'

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

function makeSource(auth: TwitchAuthManager): TwitchSource {
  return new TwitchSource('somechannel', emotes, auth, {
    badges,
    emotes: twitchEmotes,
    cheermotes: new TwitchCheermoteProvider()
  })
}

const token = encodeTwitchMenuToken({ messageId: 'm1', userId: 'u9', userLogin: 'baduser' })

/** A minimal twurple ChatMessage covering the fields the onMessage path reads. */
function ircMessage(login: string): TwitchChatMessage {
  return {
    id: `msg-${login}-${Math.random()}`,
    date: new Date(1_700_000_000_000),
    emoteOffsets: new Map(),
    bits: 0,
    isFirst: false,
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
    await source.send('hi again', 'parent-msg-id')
    expect(client.say).toHaveBeenNthCalledWith(1, 'somechannel', 'hello chat', undefined)
    expect(client.say).toHaveBeenNthCalledWith(2, 'somechannel', 'hi again', {
      replyTo: 'parent-msg-id'
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.self).toBe(true)
    expect(messages[0]?.author.id).toBe('u1')
    expect(messages[0]?.author.name).toBe('modlogin')
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
