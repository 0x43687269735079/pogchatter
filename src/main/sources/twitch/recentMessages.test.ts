import { describe, expect, it, vi } from 'vitest'
import { fetchRecentMessages, parseRecentMessages } from '@main/sources/twitch/recentMessages'

// Real-world raw IRCv3 shapes from the recent-messages API docs.
const PRIVMSG =
  '@badge-info=;badges=glhf-pledge/1;color=;display-name=viewer_one;emotes=;flags=;historical=1;id=dbb10be8-581e-4f22-ba12-2001e088529d;mod=0;rm-received-ts=1596061057185;room-id=100000001;subscriber=0;tmi-sent-ts=1596061056790;turbo=0;user-id=200000001;user-type= :viewer_one!viewer_one@viewer_one.tmi.twitch.tv PRIVMSG #demochannel LULW'
const DELETED =
  '@badge-info=subscriber/29;badges=subscriber/24;color=#7AC2A7;display-name=viewer_two;emotes=;flags=;historical=1;id=3391449d-3427-490f-836b-f5b8c1c98b93;mod=0;rm-deleted=1;rm-received-ts=1596059993412;room-id=100000001;subscriber=1;tmi-sent-ts=1596059993026;turbo=0;user-id=200000002;user-type= :viewer_two!viewer_two@viewer_two.tmi.twitch.tv PRIVMSG #demochannel :gn i guess'
const NO_TRAILING_COLON =
  '@user-id=200000003;badges=turbo/1;tmi-sent-ts=1673907853307;historical=1;color=#EF8A12;rm-received-ts=1673907853790;display-name=viewer_three;room-id=100000002;id=c220d6d3-6a55-403f-9094-94a80ae2cdcd;mod=0;emotes= :viewer_three!viewer_three@viewer_three.tmi.twitch.tv PRIVMSG #otherchannel FeelsBadMan'
const USERNOTICE_RESUB =
  '@badge-info=;badges=;color=;display-name=Sub;emotes=;flags=;id=sub-notice-1;login=sub;mod=0;msg-id=resub;room-id=100000001;subscriber=1;system-msg=Sub\\ssubscribed\\sat\\sTier\\s1.;tmi-sent-ts=1596060000000;user-id=99;user-type= :tmi.twitch.tv USERNOTICE #demochannel :been here a year'
const USERNOTICE_NO_SYSMSG =
  '@id=x;login=y;room-id=100000001;tmi-sent-ts=1596060000000;user-id=1 :tmi.twitch.tv USERNOTICE #demochannel'
const ROOMSTATE = '@emote-only=0;room-id=100000001 :tmi.twitch.tv ROOMSTATE #demochannel'

const src = 'twitch:demochannel'

describe('parseRecentMessages', () => {
  it('parses a PRIVMSG (no trailing colon) into a backlog message like the live path', () => {
    const [message] = parseRecentMessages([PRIVMSG], src, {})
    expect(message?.id).toBe('dbb10be8-581e-4f22-ba12-2001e088529d')
    expect(message?.timestamp).toBe(1596061056790) // tmi-sent-ts, not rm-received-ts
    expect(message?.author.name).toBe('viewer_one')
    expect(message?.fragments).toEqual([{ type: 'text', text: 'LULW' }])
    expect(message?.backlog).toBe(true)
    expect(message?.deleted).toBeUndefined()
  })

  it('marks an rm-deleted line as deleted (renders struck)', () => {
    const [message] = parseRecentMessages([DELETED], src, {})
    expect(message?.deleted).toBe(true)
    expect(message?.fragments).toEqual([{ type: 'text', text: 'gn i guess' }])
  })

  it('parses a line with no trailing colon on the text param (RFC 2812)', () => {
    const [message] = parseRecentMessages([NO_TRAILING_COLON], src, {})
    expect(message?.author.name).toBe('viewer_three')
    expect(message?.fragments).toEqual([{ type: 'text', text: 'FeelsBadMan' }])
  })

  it('surfaces a USERNOTICE with a system-msg as a backlog system line, skipping one without', () => {
    const messages = parseRecentMessages(
      [USERNOTICE_RESUB, USERNOTICE_NO_SYSMSG, ROOMSTATE],
      src,
      {}
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.system).toBe(true)
    expect(messages[0]?.backlog).toBe(true)
    const text = (messages[0]?.fragments ?? [])
      .map((f) => (f.type === 'text' ? f.text : ''))
      .join('')
    expect(text).toContain('Sub subscribed at Tier 1.') // system-msg tag, unescaped
    expect(text).toContain('been here a year') // the user's typed resub body
  })

  it('keeps the valid lines when a garbage line is mixed in, preserving order', () => {
    const messages = parseRecentMessages(['not an irc line at all', PRIVMSG, DELETED], src, {})
    expect(messages.map((m) => m.id)).toEqual([
      'dbb10be8-581e-4f22-ba12-2001e088529d',
      '3391449d-3427-490f-836b-f5b8c1c98b93'
    ])
  })

  it('strips the moderation menu token from backlog rows (untrusted third-party source)', () => {
    // A live PRIVMSG would carry a menuToken; a historical one must not, so it can't drive live
    // Helix moderation against ids supplied by the third-party service.
    const [message] = parseRecentMessages([PRIVMSG], src, {})
    expect(message?.menuToken).toBeUndefined()
  })

  it('gives a backlog row a finite timestamp even when its time tags are malformed', () => {
    const badTs =
      '@display-name=weird;id=weird-1;rm-received-ts=notanumber;room-id=100000001;tmi-sent-ts=notanumber;user-id=5 :weird!weird@weird.tmi.twitch.tv PRIVMSG #demochannel :hi'
    const [message] = parseRecentMessages([badTs], src, {})
    expect(message).toBeDefined()
    expect(Number.isFinite(message?.timestamp)).toBe(true)
  })
})

describe('fetchRecentMessages', () => {
  const ok = (messages: unknown): typeof fetch =>
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ messages }) }) as never

  it('returns the raw lines on a happy response', async () => {
    const lines = await fetchRecentMessages('demochannel', ok([PRIVMSG, DELETED]))
    expect(lines).toEqual([PRIVMSG, DELETED])
  })

  it('returns messages even when error_code (channel_not_joined) is present', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [PRIVMSG], error_code: 'channel_not_joined' })
    }) as never
    expect(await fetchRecentMessages('demochannel', fetchFn)).toEqual([PRIVMSG])
  })

  it('returns [] on a non-OK status, a network reject, or a non-array body', async () => {
    expect(
      await fetchRecentMessages('x', vi.fn().mockResolvedValue({ ok: false, status: 403 }) as never)
    ).toEqual([])
    expect(
      await fetchRecentMessages('x', vi.fn().mockRejectedValue(new Error('down')) as never)
    ).toEqual([])
    expect(await fetchRecentMessages('x', ok(undefined))).toEqual([])
  })

  it('builds the documented URL (limit + hide_moderation_messages, login encoded)', async () => {
    const fetchFn = ok([]) as ReturnType<typeof vi.fn>
    await fetchRecentMessages('demochannel', fetchFn as never)
    expect(fetchFn.mock.calls[0]?.[0] as string).toBe(
      'https://recent-messages.robotty.de/api/v2/recent-messages/demochannel?limit=100&hide_moderation_messages=true'
    )
  })
})
