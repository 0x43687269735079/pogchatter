import { describe, expect, it } from 'vitest'
import type { ChatMessage as TwitchChatMessage } from '@twurple/chat'
import {
  decodeTwitchMenuToken,
  encodeTwitchMenuToken,
  normalizeTwitchMessage,
  normalizeTwitchSubGift
} from '@main/sources/twitch/normalize'

/** A minimal twurple ChatMessage covering the fields `normalizeTwitchMessage` reads. */
function ircMessage(author: { userId?: string; userName?: string } = {}): TwitchChatMessage {
  return {
    id: 'msg-1',
    date: new Date(1_700_000_000_000),
    emoteOffsets: new Map(),
    bits: 0,
    isFirst: false,
    isHighlight: false,
    rewardId: null,
    isReply: false,
    parentMessageId: null,
    parentMessageText: null,
    parentMessageUserName: null,
    parentMessageUserDisplayName: null,
    threadMessageId: null,
    threadMessageUserId: null,
    userInfo: {
      userId: author.userId ?? 'u100',
      userName: author.userName ?? 'alice',
      displayName: 'Alice',
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

describe('Twitch menu token', () => {
  it('round-trips the moderation context', () => {
    const token = encodeTwitchMenuToken({ messageId: 'm1', userId: 'u1', userLogin: 'alice' })
    expect(decodeTwitchMenuToken(token)).toEqual({
      messageId: 'm1',
      userId: 'u1',
      userLogin: 'alice'
    })
  })

  it('rejects a token that is not JSON', () => {
    expect(() => decodeTwitchMenuToken('not json')).toThrow('Malformed')
  })

  it('rejects a token missing the author fields', () => {
    expect(() => decodeTwitchMenuToken('{"messageId":"m1"}')).toThrow('Malformed')
  })
})

describe('normalizeTwitchMessage menu token', () => {
  it('carries the message id and author so the source can moderate it', () => {
    const message = normalizeTwitchMessage('twitch:somechannel', 'hi', ircMessage())
    expect(message.menuToken).toBeDefined()
    expect(decodeTwitchMenuToken(message.menuToken ?? '')).toEqual({
      messageId: 'msg-1',
      userId: 'u100',
      userLogin: 'alice'
    })
  })

  it("skips the logged-in user's own messages (nothing to moderate)", () => {
    const msg = ircMessage({ userId: 'u100' })
    const message = normalizeTwitchMessage('twitch:somechannel', 'hi', msg, { selfUserId: 'u100' })
    expect(message.menuToken).toBeUndefined()
  })
})

describe('normalizeTwitchMessage avatars', () => {
  it("attaches the avatar resolver's hit for the author's login", () => {
    const message = normalizeTwitchMessage('twitch:somechannel', 'hi', ircMessage(), {
      resolveAvatar: (login) => (login === 'alice' ? 'https://cdn/alice.png' : undefined)
    })
    expect(message.author.avatarUrl).toBe('https://cdn/alice.png')
  })

  it('leaves the author bare while the login is unresolved (and when logged out)', () => {
    const miss = normalizeTwitchMessage('twitch:somechannel', 'hi', ircMessage(), {
      resolveAvatar: () => undefined
    })
    expect(miss.author.avatarUrl).toBeUndefined()
    const loggedOut = normalizeTwitchMessage('twitch:somechannel', 'hi', ircMessage())
    expect(loggedOut.author.avatarUrl).toBeUndefined()
  })
})

describe('normalizeTwitchMessage highlights', () => {
  it('marks a cheer message with a bits highlight carrying the amount', () => {
    const msg = ircMessage()
    ;(msg as { bits: number }).bits = 250
    const message = normalizeTwitchMessage('twitch:somechannel', 'Cheer250 gg', msg)
    expect(message.highlight).toEqual({ kind: 'bits', amount: 250 })
    expect(message.fragments).toEqual([{ type: 'text', text: 'Cheer250 gg' }])
  })

  it('marks a first-time chatter, but bits win when both apply', () => {
    const first = ircMessage()
    ;(first as { isFirst: boolean }).isFirst = true
    expect(normalizeTwitchMessage('s', 'hi', first).highlight).toEqual({ kind: 'first_message' })
    ;(first as { bits: number }).bits = 1
    expect(normalizeTwitchMessage('s', 'hi', first).highlight).toEqual({ kind: 'bits', amount: 1 })
  })
})

describe('normalizeTwitchMessage reply threads', () => {
  // A reply carrying parent + thread-root tags, with the root distinct from the direct parent.
  function threadedReply(overrides: Record<string, unknown> = {}): TwitchChatMessage {
    const msg = ircMessage()
    Object.assign(msg, {
      isReply: true,
      parentMessageId: 'p1',
      parentMessageUserName: 'bob',
      parentMessageUserDisplayName: 'Bob',
      parentMessageText: 'hello',
      threadMessageId: 'root1',
      ...overrides
    })
    return msg
  }

  it('records the thread root id, with no author when the root is not the parent', () => {
    const message = normalizeTwitchMessage('s', 'reply', threadedReply())
    expect(message.reply).toEqual({
      parentId: 'p1',
      parentAuthor: 'Bob',
      parentText: 'hello',
      threadId: 'root1'
    })
    expect(message.reply?.threadAuthor).toBeUndefined()
  })

  it('carries the thread author when the parent is itself the root', () => {
    const message = normalizeTwitchMessage(
      's',
      'reply',
      threadedReply({ parentMessageId: 'root1' })
    )
    expect(message.reply?.threadId).toBe('root1')
    expect(message.reply?.threadAuthor).toBe('Bob')
  })
})

describe('normalizeTwitchMessage channel points', () => {
  it('marks a channel-points "Highlight My Message" message', () => {
    const msg = ircMessage()
    ;(msg as { isHighlight: boolean }).isHighlight = true
    const message = normalizeTwitchMessage('s', 'look at me', msg)
    expect(message.highlighted).toBe(true)
    expect(message.reward).toBeUndefined()
  })

  it('tags a custom-reward message with the reward id only (never a name)', () => {
    const msg = ircMessage()
    ;(msg as { rewardId: string | null }).rewardId = 'reward-uuid'
    const message = normalizeTwitchMessage('s', 'redeemed text', msg)
    expect(message.reward).toEqual({ id: 'reward-uuid' })
    expect(message.reward?.name).toBeUndefined()
  })

  it('leaves an ordinary message free of channel-points marks', () => {
    const message = normalizeTwitchMessage('s', 'hi', ircMessage())
    expect(message.highlighted).toBeUndefined()
    expect(message.reward).toBeUndefined()
  })
})

describe('normalizeTwitchSubGift moderation context', () => {
  const subInfo = {
    userId: 'id-rec',
    displayName: 'Rec',
    plan: '9999',
    planName: 'Custom',
    isPrime: false,
    months: 1,
    giftDuration: 1
  }

  it('targets the gifter (the notice author) and tolerates unknown plans', () => {
    const msg = ircMessage({ userId: 'id-gifter', userName: 'gifter' })
    const message = normalizeTwitchSubGift('s', subInfo, msg)
    expect(message.highlight?.headerText).toBe('gifted a sub to Rec')
    expect(message.highlight?.tier).toBeUndefined()
    // noDelete: Helix cannot delete USERNOTICEs, so the card must not offer remove.
    expect(decodeTwitchMenuToken(message.menuToken ?? '')).toMatchObject({
      userId: 'id-gifter',
      noDelete: true
    })
  })

  it('skips the menu token when the logged-in user is the gifter', () => {
    const msg = ircMessage({ userId: 'id-gifter' })
    const message = normalizeTwitchSubGift('s', subInfo, msg, { selfUserId: 'id-gifter' })
    expect(message.menuToken).toBeUndefined()
  })

  it('renders anonymous gifts as "Anonymous" with no moderation menu', () => {
    const msg = ircMessage({ userId: 'id-anon', userName: 'ananonymousgifter' })
    const message = normalizeTwitchSubGift('s', subInfo, msg)
    expect(message.author.displayName).toBe('Anonymous')
    expect(message.menuToken).toBeUndefined()
  })
})

describe('normalizeTwitchMessage cheermotes', () => {
  // Names are lowercased — twurple's parser matches against (and reports back) lowercase names.
  const cheermotes = {
    names: () => ['cheer'],
    resolve: (name: string, bits: number) =>
      name === 'cheer' && bits >= 100
        ? { url: 'https://cdn/cheer100.gif', animated: true }
        : undefined
  }

  it('renders a cheer as its tier image followed by the amount', () => {
    const msg = ircMessage()
    ;(msg as { bits: number }).bits = 100
    const message = normalizeTwitchMessage('s', 'Cheer100 gg', msg, { cheermotes })
    expect(message.fragments).toEqual([
      {
        type: 'emote',
        code: 'Cheer100',
        url: 'https://cdn/cheer100.gif',
        provider: 'twitch',
        animated: true
      },
      // verbatim: the amount must survive the third-party emote pass untouched.
      { type: 'text', text: '100', verbatim: true },
      { type: 'text', text: ' gg' }
    ])
    expect(message.highlight).toEqual({ kind: 'bits', amount: 100 })
  })

  it('keeps the cheer as text when no art is known for its tier', () => {
    const msg = ircMessage()
    ;(msg as { bits: number }).bits = 50
    const message = normalizeTwitchMessage('s', 'Cheer50 hi', msg, { cheermotes })
    expect(message.fragments).toEqual([
      { type: 'text', text: 'Cheer50', verbatim: true },
      { type: 'text', text: ' hi' }
    ])
  })

  it('never cheer-parses a message that carries no bits', () => {
    const message = normalizeTwitchMessage('s', 'Cheer100 hi', ircMessage(), { cheermotes })
    expect(message.fragments).toEqual([{ type: 'text', text: 'Cheer100 hi' }])
  })
})
