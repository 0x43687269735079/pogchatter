import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/model'
import { parseTipAnnouncement } from '@shared/tipMessage'

function botMessage(text: string, login = 'streamelements'): ChatMessage {
  return {
    id: 'm1',
    platform: 'twitch',
    channelId: 'tw:chan',
    timestamp: 1_700_000_000_000,
    author: { id: 'b1', name: login, displayName: login, badges: [], roles: {} as never },
    fragments: [{ type: 'text', text }]
  }
}

const REAL =
  'pebble_42 just tipped £100.00! thank you for the chocolate funds~ here’s what they say: hippo birdie'

describe('parseTipAnnouncement', () => {
  it('reads the donor, amount and message from a real announcement', () => {
    expect(parseTipAnnouncement(botMessage(REAL))).toEqual({
      donor: 'pebble_42',
      amount: '£100.00',
      text: 'hippo birdie'
    })
  })

  it('copes with the streamer having rewritten the thank-you wording', () => {
    // Only the lead-in is relied upon; everything after it is the streamer's own text.
    const custom = 'alice_b just tipped $5.00! you are a legend and the stream thanks you'
    expect(parseTipAnnouncement(botMessage(custom))).toEqual({
      donor: 'alice_b',
      amount: '$5.00',
      text: ''
    })
  })

  it('handles a straight apostrophe as well as a curly one', () => {
    const straight = "bob just tipped €20,00! here's what they say: danke"
    expect(parseTipAnnouncement(botMessage(straight))?.text).toBe('danke')
  })

  it('refuses an announcement from anyone but the official StreamElements account', () => {
    // The safeguard that matters: otherwise any viewer could plant a fake donation by typing one.
    expect(parseTipAnnouncement(botMessage(REAL, 'random_viewer'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage(REAL, 'pebble_42'))).toBeUndefined()
    // Other donation bots are not trusted either — the trusted set is exactly one account, so
    // widening it is a decision rather than something that happens by resemblance.
    expect(parseTipAnnouncement(botMessage(REAL, 'streamlabs'))).toBeUndefined()
    // Nor is a lookalike login that merely contains the trusted one.
    expect(parseTipAnnouncement(botMessage(REAL, 'streamelements_'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage(REAL, 'notstreamelements'))).toBeUndefined()
  })

  it('accepts the official account whatever case the platform reports it in', () => {
    expect(parseTipAnnouncement(botMessage(REAL, 'StreamElements'))?.donor).toBe('pebble_42')
    expect(parseTipAnnouncement(botMessage(REAL, 'STREAMELEMENTS'))?.donor).toBe('pebble_42')
  })

  it('refuses a YouTube message even from a channel named exactly like the bot', () => {
    // On YouTube `name` is the mutable display name, so the login gate cannot vouch for identity —
    // any viewer could rename to "StreamElements" and forge a tip. Recognition is Twitch-only.
    const onYouTube: ChatMessage = { ...botMessage(REAL, 'streamelements'), platform: 'youtube' }
    expect(parseTipAnnouncement(onYouTube)).toBeUndefined()
  })

  it('accepts a donor name with spaces, as the tip page allows', () => {
    expect(parseTipAnnouncement(botMessage('John Smith just tipped $5.00! thanks'))?.donor).toBe(
      'John Smith'
    )
  })

  it('folds every way of not being named into one Anonymous donor', () => {
    // Money given without a name is still money given; the panel must count it and group it.
    for (const lead of ['Anonymous', 'anonymous', 'An anonymous user', 'Someone', '***']) {
      expect(parseTipAnnouncement(botMessage(`${lead} just tipped £5.00!`))?.donor).toBe(
        'Anonymous'
      )
    }
    expect(parseTipAnnouncement(botMessage('Anonymous just tipped £5.00!'))?.amount).toBe('£5.00')
  })

  it('ignores bot chatter that merely resembles a tip', () => {
    expect(parseTipAnnouncement(botMessage('that just tipped the scales!'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage('welcome to the stream!'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage('alice just tipped !'))).toBeUndefined()
  })
})
