import { describe, expect, it } from 'vitest'
import { buildEmoteImageUrl, type ChatMessage as TwitchChatMessage } from '@twurple/chat'
import {
  decodeTwitchMenuToken,
  encodeTwitchMenuToken,
  normalizeTwitchAnnouncement,
  normalizeTwitchCommunitySub,
  normalizeTwitchMessage,
  normalizeTwitchNotice,
  normalizeTwitchSub,
  normalizeTwitchSubGift
} from '@main/sources/twitch/normalize'

/** A minimal twurple ChatMessage covering the fields `normalizeTwitchMessage` reads. */
function ircMessage(
  author: { userId?: string; userName?: string } = {},
  tags: Map<string, string> = new Map()
): TwitchChatMessage {
  return {
    id: 'msg-1',
    date: new Date(1_700_000_000_000),
    emoteOffsets: new Map(),
    tags,
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

  it('tags a custom-reward message with the reward id, with no name when unresolved', () => {
    const msg = ircMessage()
    ;(msg as { rewardId: string | null }).rewardId = 'reward-uuid'
    const message = normalizeTwitchMessage('s', 'redeemed text', msg)
    expect(message.reward).toEqual({ id: 'reward-uuid' })
    expect(message.reward?.name).toBeUndefined()
  })

  it('fills the reward name when the resolver knows the reward', () => {
    const msg = ircMessage()
    ;(msg as { rewardId: string | null }).rewardId = 'reward-uuid'
    const message = normalizeTwitchMessage('s', 'redeemed text', msg, {
      resolveReward: (id) => (id === 'reward-uuid' ? 'Hydrate!' : undefined)
    })
    expect(message.reward).toEqual({ id: 'reward-uuid', name: 'Hydrate!' })
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

describe("Twitch's anonymous service accounts", () => {
  it('labels an anonymous cheer and offers no moderation menu', () => {
    // Anonymous cheers arrive as an ordinary PRIVMSG from Twitch's shared AnAnonymousCheerer
    // account — banning it would moderate no one and block the channel's future anonymous cheers.
    const msg = ircMessage({ userId: 'id-anon-cheer', userName: 'ananonymouscheerer' })
    ;(msg as { bits: number }).bits = 500
    const message = normalizeTwitchMessage('s', 'Cheer500', msg)
    expect(message.highlight).toEqual({ kind: 'bits', amount: 500 })
    expect(message.author.displayName).toBe('Anonymous')
    expect(message.menuToken).toBeUndefined()
  })

  it('labels an anonymous community gift while keeping its batch count', () => {
    const msg = ircMessage({ userId: 'id-anon-gift', userName: 'ananonymousgifter' })
    const message = normalizeTwitchCommunitySub('s', { count: 5, plan: '1000' }, msg)
    expect(message.highlight).toMatchObject({ kind: 'membership_gift', count: 5 })
    expect(message.author.displayName).toBe('Anonymous')
    expect(message.menuToken).toBeUndefined()
  })

  it('still moderates (and names) an ordinary cheerer', () => {
    const msg = ircMessage()
    ;(msg as { bits: number }).bits = 500
    const message = normalizeTwitchMessage('s', 'Cheer500', msg)
    expect(message.author.displayName).toBe('Alice')
    expect(message.menuToken).toBeDefined()
  })
})

describe('normalizeTwitchSub gifted-sub renewals', () => {
  const subInfo = {
    userId: 'u100',
    displayName: 'Alice',
    plan: '1000',
    planName: 'T1',
    isPrime: false,
    months: 6
  }

  it('marks a month of a multi-month gifted sub as not a purchase', () => {
    // The gifter's purchase was already announced (and counted) when they bought the gift.
    const message = normalizeTwitchSub(
      's',
      { ...subInfo, originalGiftInfo: { anonymous: true, duration: 6, redeemedMonth: 2 } },
      ircMessage(),
      'resub'
    )
    expect(message.highlight?.notAPurchase).toBe(true)
  })

  it('leaves a self-paid resub countable', () => {
    const message = normalizeTwitchSub('s', subInfo, ircMessage(), 'resub')
    expect(message.highlight?.notAPurchase).toBeUndefined()
  })
})

describe('normalizeTwitchNotice', () => {
  it('renders a system line carrying the description while keeping the author for the log', () => {
    const msg = ircMessage({ userId: 'u-raider', userName: 'raider' })
    const message = normalizeTwitchNotice('s', msg, 'Raider is raiding with 50 viewers')
    expect(message.system).toBe(true)
    expect(message.fragments).toEqual([{ type: 'text', text: 'Raider is raiding with 50 viewers' }])
    expect(message.author.name).toBe('raider')
  })
})

describe('normalizeTwitchAnnouncement', () => {
  it('prefixes the announcer name and tokenizes the announcement body', () => {
    const message = normalizeTwitchAnnouncement('s', 'hello chat', ircMessage({ userName: 'mod' }))
    expect(message.system).toBe(true)
    expect(message.fragments[0]).toEqual({ type: 'text', text: '📣 Alice: ' })
    expect(message.fragments[1]).toEqual({ type: 'text', text: 'hello chat' })
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

describe('normalizeTwitchMessage gifs tag', () => {
  it("splices Twitch's documented GIF example into a single link fragment", () => {
    const text = '[Y A Y Yes GIF by Djemilah Birnie]'
    const url =
      'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=abc&ep=v1_gifs_trending&rid=giphy.gif&ct=g'
    const tags = new Map([['gifs', `0-33|joSNxeswxuc74Juo8X|${url}`]])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([{ type: 'link', text, url }])
  })

  it('positions the GIF by code points, so an emoji before it does not shift the range', () => {
    // A supplementary-plane character is two UTF-16 units but one code point; the tag counts the
    // latter (like the emotes tag), and so must the splice.
    const placeholder = '[Y A Y Yes GIF by X]'
    const text = `🙂 ${placeholder}`
    const start = 2
    const end = start + [...placeholder].length - 1
    const tags = new Map([['gifs', `${start}-${end}|abc|https://cdn/x.gif`]])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([
      { type: 'text', text: '🙂 ' },
      { type: 'link', text: placeholder, url: 'https://cdn/x.gif' }
    ])
  })

  it('leaves the text unchanged when the range is not numeric', () => {
    const text = 'hello world'
    const tags = new Map([['gifs', 'abc|x|https://a']])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([{ type: 'text', text }])
  })

  it('drops a non-https GIF url, leaving the text unchanged', () => {
    const text = 'hello'
    const tags = new Map([['gifs', '0-3|x|http://a']])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([{ type: 'text', text }])
  })

  it('keeps the full URL when it contains pipes', () => {
    const text = 'gif here'
    const url = 'https://cdn/x?a=1|b=2'
    const tags = new Map([['gifs', `0-2|abc|${url}`]])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([
      { type: 'link', text: 'gif', url },
      { type: 'text', text: ' here' }
    ])
  })

  it('keeps a preceding emote fragment alongside the GIF link', () => {
    const text = 'Kappa hello'
    const tags = new Map([['gifs', '6-10|abc|https://cdn/g.gif']])
    const msg = ircMessage({}, tags)
    ;(msg as { emoteOffsets: Map<string, string[]> }).emoteOffsets = new Map([['e1', ['0-4']]])
    const message = normalizeTwitchMessage('s', text, msg)
    expect(message.fragments).toEqual([
      {
        type: 'emote',
        code: 'Kappa',
        url: buildEmoteImageUrl('e1', { size: '2.0', backgroundType: 'dark' }),
        provider: 'twitch'
      },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'hello', url: 'https://cdn/g.gif' }
    ])
  })

  it('ignores an entry whose range runs past the end of the text', () => {
    const text = 'hi'
    const tags = new Map([['gifs', '0-5|abc|https://cdn/g.gif']])
    const message = normalizeTwitchMessage('s', text, ircMessage({}, tags))
    expect(message.fragments).toEqual([{ type: 'text', text }])
  })

  it('leaves a message with no gifs tag unchanged', () => {
    const message = normalizeTwitchMessage('s', 'plain text', ircMessage())
    expect(message.fragments).toEqual([{ type: 'text', text: 'plain text' }])
  })
})
