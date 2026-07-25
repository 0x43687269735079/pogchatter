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
  'kota3684 just tipped £100.00! thank you for the chocolate funds~ here’s what they say: hippo birdie'

describe('parseTipAnnouncement', () => {
  it('reads the donor, amount and message from a real announcement', () => {
    expect(parseTipAnnouncement(botMessage(REAL))).toEqual({
      donor: 'kota3684',
      amount: '£100.00',
      text: 'hippo birdie'
    })
  })

  it('copes with the streamer having rewritten the thank-you wording', () => {
    // Only the lead-in is relied upon; everything after it is the streamer's own text.
    const custom = 'someone just tipped $5.00! you are a legend and the stream thanks you'
    expect(parseTipAnnouncement(botMessage(custom))).toEqual({
      donor: 'someone',
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
    expect(parseTipAnnouncement(botMessage(REAL, 'kota3684'))).toBeUndefined()
    // Other donation bots are not trusted either — the trusted set is exactly one account, so
    // widening it is a decision rather than something that happens by resemblance.
    expect(parseTipAnnouncement(botMessage(REAL, 'streamlabs'))).toBeUndefined()
    // Nor is a lookalike login that merely contains the trusted one.
    expect(parseTipAnnouncement(botMessage(REAL, 'streamelements_'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage(REAL, 'notstreamelements'))).toBeUndefined()
  })

  it('accepts the official account whatever case the platform reports it in', () => {
    expect(parseTipAnnouncement(botMessage(REAL, 'StreamElements'))?.donor).toBe('kota3684')
    expect(parseTipAnnouncement(botMessage(REAL, 'STREAMELEMENTS'))?.donor).toBe('kota3684')
  })

  it('ignores bot chatter that merely resembles a tip', () => {
    expect(parseTipAnnouncement(botMessage('that just tipped the scales!'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage('welcome to the stream!'))).toBeUndefined()
    expect(parseTipAnnouncement(botMessage('alice just tipped !'))).toBeUndefined()
  })
})
