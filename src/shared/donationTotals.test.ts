import { describe, expect, it } from 'vitest'
import type { Donation, DonationKind, DonationValue, RateTable } from '@shared/donations'
import type { Platform } from '@shared/model'
import { donationTotals } from '@shared/donationTotals'

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
    read: false
  }
}

const money = (amount: number, currency: string): DonationValue => ({
  unit: 'money',
  amount,
  currency,
  original: `${amount} ${currency}`
})

describe('donationTotals', () => {
  it('keeps the platforms apart, with no combined figure anywhere', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'superchat', money(5, 'GBP')),
        donation('twitch', 'bits', { unit: 'bits', bits: 500 }),
        donation('twitch', 'subscription', { unit: 'count' })
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.youtube.converted).toBe(5)
    expect(totals.twitch).toEqual({ bits: 500, subs: 1 })
    // The shape itself must offer no place to put a cross-platform sum.
    expect(Object.keys(totals).sort()).toEqual(['twitch', 'youtube'])
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
    expect(totals.youtube.converted).toBeCloseTo(15)
  })

  it('excludes what it cannot convert instead of understating silently', () => {
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
    expect(totals.youtube.converted).toBe(5)
    expect(totals.youtube.excluded).toBe(2)
  })

  it('counts memberships and gifts rather than summing them', () => {
    const totals = donationTotals(
      [
        donation('youtube', 'membership', { unit: 'count' }),
        donation('youtube', 'membership_gift', { unit: 'count' })
      ],
      rates,
      'GBP',
      0
    )
    expect(totals.youtube.memberships).toBe(2)
    expect(totals.youtube.converted).toBe(0)
    expect(totals.youtube.excluded).toBe(0)
  })

  it('counts a Twitch gift sub as a sub, not a YouTube membership', () => {
    // membership_gift is cross-platform; only `platform` tells the two apart.
    const totals = donationTotals(
      [donation('twitch', 'membership_gift', { unit: 'count' })],
      rates,
      'GBP',
      0
    )
    expect(totals.twitch.subs).toBe(1)
    expect(totals.youtube.memberships).toBe(0)
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
    expect(totals.youtube.converted).toBe(5)
  })

  it('reports everything as excluded when rates have never arrived', () => {
    const totals = donationTotals(
      [donation('youtube', 'superchat', money(1900, 'JPY'))],
      undefined,
      'GBP',
      0
    )
    expect(totals.youtube.converted).toBe(0)
    expect(totals.youtube.excluded).toBe(1)
  })
})
