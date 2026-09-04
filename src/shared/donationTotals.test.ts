import { describe, expect, it } from 'vitest'
import type { Donation, DonationKind, DonationValue, RateTable } from '@shared/donations'
import type { Platform } from '@shared/model'
import { donationTotals, excludedCount } from '@shared/donationTotals'

const rates: RateTable = { base: 'GBP', rates: { JPY: 190, USD: 1.25 }, fetchedAt: 0, stale: false }

let seq = 0
function donation(
  platform: Platform,
  kind: DonationKind,
  value: DonationValue,
  timestamp = 1_000
): Donation {
  seq += 1
  return {
    id: `d${seq}`,
    channelId: `${platform}:c`,
    platform,
    kind,
    author: { id: 'u', displayName: 'U' },
    timestamp,
    value,
    text: '',
    read: false,
    streamerKey: 'x'
  }
}

const money = (amount: number, currency: string): DonationValue => ({
  unit: 'money',
  amount,
  currency,
  original: `${amount} ${currency}`
})

describe('donationTotals', () => {
  it('separates the kinds instead of rolling them into one figure', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', money(5, 'GBP')),
        donation('youtube', 'superchat', money(3, 'GBP')),
        donation('youtube', 'supersticker', money(2, 'GBP')),
        donation('youtube', 'membership', { unit: 'count', count: 1 })
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.youtube.superchat).toEqual({ count: 2, converted: 8, excluded: 0, bits: 0 })
    expect(totals.youtube.supersticker).toEqual({ count: 1, converted: 2, excluded: 0, bits: 0 })
    expect(totals.youtube.membership?.count).toBe(1)
    // A kind that never arrived has no line at all, rather than a zero row.
    expect(totals.youtube.membership_gift).toBeUndefined()
  })

  it('keeps the platforms apart, with no combined figure anywhere', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', money(5, 'GBP')),
        donation('twitch', 'bits', { unit: 'bits', bits: 500 }),
        donation('twitch', 'subscription', { unit: 'count', count: 1 })
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.twitch.bits).toEqual({ count: 1, converted: 0, excluded: 0, bits: 500 })
    expect(totals.twitch.subscription?.count).toBe(1)
    expect(Object.keys(totals).sort()).toEqual(['twitch', 'youtube'])
  })

  it('counts a Twitch gift sub under Twitch, not as a YouTube membership', () => {
    // membership_gift is cross-platform; only `platform` tells the two apart.
    const totals = donationTotals(
      [
        donation('twitch', 'membership_gift', { unit: 'count', count: 1 }),
        donation('youtube', 'membership_gift', { unit: 'count', count: 1 })
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.twitch.membership_gift?.count).toBe(1)
    expect(totals.youtube.membership_gift?.count).toBe(1)
  })

  it('converts foreign amounts into the base currency', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', money(1900, 'JPY')),
        donation('youtube', 'superchat', money(5, 'GBP'))
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.youtube.superchat?.converted).toBeCloseTo(15)
  })

  it('records what it could not convert rather than understating silently', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', { unit: 'money-unparsed', original: 'kr 50' }),
        donation('youtube', 'superchat', money(10, 'PEN')), // not in the table
        donation('youtube', 'superchat', money(5, 'GBP'))
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.youtube.superchat?.converted).toBe(5)
    expect(totals.youtube.superchat?.excluded).toBe(2)
    expect(totals.youtube.superchat?.count).toBe(3) // still counted as donations
    expect(excludedCount(totals.youtube)).toBe(2)
  })

  it('ignores donations from before the session started', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', money(100, 'GBP'), 500), // last session
        donation('youtube', 'superchat', money(5, 'GBP'), 1_500)
      ],
      rates,
      'GBP',
      1_000
    )
    expect(totals.youtube.superchat?.converted).toBe(5)
    expect(totals.youtube.superchat?.count).toBe(1)
  })

  it('treats everything as excluded when rates have never arrived', () => {
    const totals = donationTotals(
      [donation('youtube', 'superchat', money(1900, 'JPY'))],
      undefined,
      'GBP',
      0
    )
    expect(totals.youtube.superchat?.converted).toBe(0)
    expect(totals.youtube.superchat?.excluded).toBe(1)
  })

  it('is empty when nothing arrived this session', () => {
    const totals = donationTotals([], rates, 'GBP', 0)
    expect(totals).toEqual({ youtube: {}, twitch: {} })
    expect(excludedCount(totals.youtube)).toBe(0)
  })
})

describe('donationTotals quantities', () => {
  it('counts the subs a community gift covered, not the single event', () => {
    const totals = donationTotals(
      [donation('twitch', 'membership_gift', { unit: 'count', count: 20 })],
      rates,
      'GBP',
      0
    )
    expect(totals.twitch.membership_gift?.count).toBe(20)
  })

  it('totals a base-currency donation even before any rates arrive', () => {
    // Otherwise a first run or an offline session reports everything as unrecognised and reads zero.
    const totals = donationTotals(
      [donation('youtube', 'superchat', money(5, 'GBP'))],
      undefined,
      'GBP',
      0
    )
    expect(totals.youtube.superchat?.converted).toBe(5)
    expect(totals.youtube.superchat?.excluded).toBe(0)
  })
})
