import { describe, expect, it } from 'vitest'
import { emoteLines, messageLine } from '@main/chatLog/logLines'
import { fragmentsFrom, messageFromLine, parseLogLine } from '@main/chatLog/logReader'
import type { ChatMessage } from '@shared/model'
import type { UserHistoryStream } from '@shared/userHistory'

const KAPPA = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
const SEVEN_TV = 'https://cdn.7tv.app/emote/01ABCDEFGHJKMNPQRSTVWXYZ00/1x.webp'

const STREAM: UserHistoryStream = {
  id: 'somechannel/2026-11-01T18-00-00Z_41234567890',
  platform: 'twitch',
  owner: 'somechannel',
  streamKey: '2026-11-01T18-00-00Z_41234567890',
  channelId: 'twitch:somechannel'
}

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    platform: 'twitch',
    channelId: 'twitch:somechannel',
    timestamp: 1_793_000_000_000,
    author: {
      id: '123456789',
      name: 'ada_l',
      displayName: 'Ada_L',
      badges: [],
      roles: { broadcaster: false, moderator: false }
    },
    fragments: [
      { type: 'text', text: 'hello ' },
      { type: 'emote', code: 'Kappa', url: KAPPA, provider: 'twitch' },
      { type: 'text', text: ' there' }
    ],
    ...overrides
  }
}

/** What the logger writes for a message, read back through the reader. */
function roundTrip(message: ChatMessage): ChatMessage {
  const emotes = new Map<string, string>()
  emoteLines(message, emotes)
  const parsed = parseLogLine(JSON.stringify(messageLine(message)))
  if (parsed?.kind !== 'message') {
    throw new Error(`expected a message line, got ${JSON.stringify(parsed)}`)
  }
  const fragments = fragmentsFrom(parsed.line.m, emotes, parsed.line.e, STREAM.platform)
  return messageFromLine(parsed.line, STREAM, fragments)
}

describe('parseLogLine', () => {
  it('is total: any string gives a line or undefined, never a throw', () => {
    for (const text of ['', ' ', 'null', '[]', '42', '"x"', '{', '{"k":5}', '\u0000', '{"k":[]}']) {
      expect(() => parseLogLine(text)).not.toThrow()
    }
    expect(parseLogLine('null')).toBeUndefined()
    expect(parseLogLine('[1,2]')).toBeUndefined()
    expect(parseLogLine('{"k":5}')).toBeUndefined()
  })

  it('rejects a message missing a required field or with a wrong type', () => {
    const good = { t: 1, id: 'm1', uid: 'u1', u: 'Ada', m: 'hi' }
    expect(parseLogLine(JSON.stringify(good))?.kind).toBe('message')
    for (const field of ['t', 'id', 'uid', 'u', 'm'] as const) {
      const { [field]: _dropped, ...missing } = good
      expect(parseLogLine(JSON.stringify(missing))).toBeUndefined()
      expect(parseLogLine(JSON.stringify({ ...good, [field]: { nested: true } }))).toBeUndefined()
    }
    expect(parseLogLine(JSON.stringify({ ...good, t: 'yesterday' }))).toBeUndefined()
  })

  it('drops optional fields of the wrong type instead of trusting them', () => {
    const line = { t: 1, id: 'm1', uid: 'u1', u: 'Ada', m: 'hi', del: true, h: 7, e: [1], d: 'x' }
    const parsed = parseLogLine(JSON.stringify(line))
    expect(parsed).toEqual({
      kind: 'message',
      line: { t: 1, id: 'm1', uid: 'u1', u: 'Ada', m: 'hi' }
    })
  })

  it('reads every non-message kind, and an unknown kind as unknown', () => {
    expect(
      parseLogLine(
        '{"k":"stream","v":1,"p":"twitch","ch":"twitch:somechannel","key":"k1","title":"T","started":5}'
      )
    ).toEqual({
      kind: 'header',
      channelId: 'twitch:somechannel',
      streamKey: 'k1',
      title: 'T',
      startedAt: 5
    })
    expect(parseLogLine(`{"k":"emote","c":"Kappa","url":"${KAPPA}"}`)).toEqual({
      kind: 'emote',
      code: 'Kappa',
      url: KAPPA
    })
    expect(parseLogLine('{"t":9,"k":"del","id":"m1"}')).toEqual({ kind: 'del', id: 'm1' })
    expect(parseLogLine('{"t":9,"k":"clear-user","uid":"u1"}')).toEqual({
      kind: 'clearUser',
      uid: 'u1',
      at: 9
    })
    expect(parseLogLine('{"t":9,"k":"clear-all"}')).toEqual({ kind: 'clearAll', at: 9 })
    expect(parseLogLine('{"k":"poll","q":"?"}')).toEqual({ kind: 'unknown' })
    expect(parseLogLine('{"k":"clear-user"}')).toBeUndefined()
    expect(parseLogLine('{"k":"stream"}')).toBeUndefined()
  })
})

describe('fragmentsFrom', () => {
  it('turns known codes into emotes and keeps the rest, spacing included, as text', () => {
    const fragments = fragmentsFrom(
      'hi  Kappa\tthere',
      new Map([['Kappa', KAPPA]]),
      undefined,
      'twitch'
    )
    expect(fragments).toEqual([
      { type: 'text', text: 'hi  ' },
      { type: 'emote', code: 'Kappa', url: KAPPA, provider: 'twitch' },
      { type: 'text', text: '\tthere' }
    ])
  })

  it('applies the per-message override to the emotes in order', () => {
    const emotes = new Map([['LUL', KAPPA]])
    const fragments = fragmentsFrom('LUL LUL', emotes, [KAPPA, SEVEN_TV], 'twitch')
    expect(
      fragments.filter((f) => f.type === 'emote').map((f) => (f.type === 'emote' ? f.url : ''))
    ).toEqual([KAPPA, SEVEN_TV])
  })

  it('keeps a code as text when its image is on a host outside the emote CDNs', () => {
    const emotes = new Map([
      ['Spy', 'https://tracker.example/pixel.gif'],
      ['Cred', 'https://user:pw@cdn.7tv.app/emote/x/1x.webp']
    ])
    expect(fragmentsFrom('Spy Cred', emotes, undefined, 'youtube')).toEqual([
      { type: 'text', text: 'Spy Cred' }
    ])
  })

  it('returns no fragments for empty text', () => {
    expect(fragmentsFrom('', new Map(), undefined, 'twitch')).toEqual([])
  })
})

describe('messageFromLine', () => {
  it('round-trips a chat message through the logger and back', () => {
    const original = chatMessage()
    expect(roundTrip(original)).toEqual(original)
  })

  it('keeps a highlight, flags, the handle and the reward', () => {
    const original = chatMessage({
      highlight: { kind: 'bits', amount: 100, displayAmount: '100 bits', tier: '1000' },
      deleted: true,
      self: true,
      backlog: true,
      reward: { id: 'b3f1e0c2-1111-4222-8333-444455556666' }
    })
    const back = roundTrip(original)
    expect(back.highlight).toEqual(original.highlight)
    expect(back.deleted).toBe(true)
    expect(back.self).toBe(true)
    expect(back.backlog).toBe(true)
    expect(back.reward).toEqual(original.reward)
    expect(back.author.name).toBe('ada_l')
  })

  it('marks a held message held, with no review actions', () => {
    const back = roundTrip(chatMessage({ held: { headerText: 'Held', actions: [] } }))
    expect(back.held).toEqual({ headerText: 'Held for review', actions: [] })
  })

  it('takes the display name as the handle when no separate handle was logged', () => {
    const original = chatMessage()
    original.author.name = original.author.displayName
    expect(roundTrip(original).author.name).toBe('Ada_L')
  })
})

describe('logReader round-trip details', () => {
  const WAVE = 'https://yt3.ggpht.com/wave123=w24-h24-c-k-nd'

  it('splits adjacent YouTube emoji the logger wrote with no space between them', () => {
    const emotes = new Map([[':wave:', WAVE]])
    expect(fragmentsFrom('hi:wave::wave: ok', emotes, undefined, 'youtube')).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'emote', code: ':wave:', url: WAVE, provider: 'youtube' },
      { type: 'emote', code: ':wave:', url: WAVE, provider: 'youtube' },
      { type: 'text', text: ' ok' }
    ])
  })

  it('never finds other codes inside a word', () => {
    const emotes = new Map([['Kappa', KAPPA]])
    expect(fragmentsFrom('NotKappa Kappa', emotes, undefined, 'twitch')).toEqual([
      { type: 'text', text: 'NotKappa ' },
      { type: 'emote', code: 'Kappa', url: KAPPA, provider: 'twitch' }
    ])
  })

  it('keeps a logged reward name as its name, and a reward id as an id', () => {
    const named = roundTrip(
      chatMessage({ reward: { id: 'b3f1e0c2-1111-4222-8333-444455556666', name: 'Choose a song' } })
    )
    expect(named.reward).toEqual({ id: 'Choose a song', name: 'Choose a song' })
    const bare = roundTrip(chatMessage({ reward: { id: 'b3f1e0c2-1111-4222-8333-444455556666' } }))
    expect(bare.reward).toEqual({ id: 'b3f1e0c2-1111-4222-8333-444455556666' })
  })

  it('reads a held message that was removed as removed, not held', () => {
    const back = roundTrip(
      chatMessage({ held: { headerText: 'Held', actions: [] }, deleted: true })
    )
    expect(back.deleted).toBe(true)
    expect(back.held).toBeUndefined()
  })
})
