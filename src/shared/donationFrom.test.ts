import { describe, expect, it } from 'vitest'
import type { ChatMessage, Highlight, Platform } from '@shared/model'
import { donationFrom } from '@shared/donationFrom'

function message(
  over: { highlight?: Highlight; platform?: Platform; text?: string; deleted?: boolean } = {}
): ChatMessage {
  const built: ChatMessage = {
    id: 'm1',
    platform: over.platform ?? 'youtube',
    channelId: 'yt:vid',
    timestamp: 1_700_000_000_000,
    author: { id: 'u1', name: 'alice', displayName: 'Alice', badges: [], roles: {} as never },
    fragments: over.text === undefined ? [] : [{ type: 'text', text: over.text }]
  }
  if (over.highlight !== undefined) {
    built.highlight = over.highlight
  }
  if (over.deleted === true) {
    built.deleted = true
  }
  return built
}

describe('donationFrom', () => {
  it('collects a Super Chat with its parsed amount', () => {
    const donation = donationFrom(
      message({ highlight: { kind: 'superchat', displayAmount: '¥1,500' }, text: 'hello' }),
      'yt:vid'
    )
    expect(donation?.kind).toBe('superchat')
    expect(donation?.value).toEqual({
      unit: 'money',
      amount: 1500,
      currency: 'JPY',
      original: '¥1,500'
    })
    expect(donation?.text).toBe('hello')
    expect(donation?.read).toBe(false)
  })

  it('keeps an unparseable amount verbatim instead of guessing a currency', () => {
    const donation = donationFrom(
      message({ highlight: { kind: 'superchat', displayAmount: 'kr 50' } }),
      'yt:vid'
    )
    expect(donation?.value).toEqual({ unit: 'money-unparsed', original: 'kr 50' })
  })

  it('records Twitch bits in bits, never converted to money', () => {
    const donation = donationFrom(
      message({ platform: 'twitch', highlight: { kind: 'bits', amount: 500 } }),
      'tw:chan'
    )
    expect(donation?.value).toEqual({ unit: 'bits', bits: 500 })
  })

  it('counts memberships and gifts, which carry no amount', () => {
    expect(donationFrom(message({ highlight: { kind: 'membership' } }), 'yt:v')?.value).toEqual({
      unit: 'count',
      count: 1
    })
    // A Twitch gift sub normalises to the same kind as a YouTube gifted membership.
    const gift = donationFrom(
      message({ platform: 'twitch', highlight: { kind: 'membership_gift' } }),
      'tw:chan'
    )
    expect(gift?.kind).toBe('membership_gift')
    expect(gift?.platform).toBe('twitch')
  })

  it('ignores everything that is not a paid event', () => {
    expect(donationFrom(message({ text: 'just chatting' }), 'yt:v')).toBeUndefined()
    expect(donationFrom(message({ highlight: { kind: 'first_message' } }), 'yt:v')).toBeUndefined()
  })

  it('marks a donation whose message was already removed', () => {
    const donation = donationFrom(
      message({ highlight: { kind: 'superchat', displayAmount: '$5.00' }, deleted: true }),
      'yt:v'
    )
    expect(donation?.removed).toBe(true)
  })
})

describe('donationFrom exclusions', () => {
  it('ignores chat history, which predates the session and was never ours to acknowledge', () => {
    const historic = message({ highlight: { kind: 'bits', amount: 500 }, platform: 'twitch' })
    historic.backlog = true
    expect(donationFrom(historic, 'tw:chan')).toBeUndefined()
  })

  it('ignores membership lines that are not themselves a purchase', () => {
    // A milestone from a long-standing member, and a gift reaching its recipient: both would
    // otherwise be counted on top of the money that was actually spent.
    const milestone = message({ highlight: { kind: 'membership', notAPurchase: true } })
    expect(donationFrom(milestone, 'yt:v')).toBeUndefined()
  })

  it('carries how many subs a community gift covered', () => {
    // "is gifting 20 subs" is one event but twenty subs; counting events understated it twentyfold.
    const gift = message({
      platform: 'twitch',
      highlight: { kind: 'membership_gift', count: 20 }
    })
    expect(donationFrom(gift, 'tw:chan')?.value).toEqual({ unit: 'count', count: 20 })
  })

  it('represents an emote-only message rather than storing nothing', () => {
    const emoteOnly = message({ highlight: { kind: 'superchat', displayAmount: '$5.00' } })
    emoteOnly.fragments = [
      { type: 'emote', code: 'Kappa', url: 'u', provider: '7tv' },
      { type: 'emote', code: 'PogChamp', url: 'u', provider: '7tv' }
    ]
    expect(donationFrom(emoteOnly, 'yt:v')?.text).toBe('KappaPogChamp')
  })
})
