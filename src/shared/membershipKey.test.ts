import { describe, expect, it } from 'vitest'
import type { Donation, DonationKind, DonationValue } from '@shared/donations'
import type { Platform } from '@shared/model'
import { membershipDedupKey } from '@shared/membershipKey'

function donation(over: {
  platform?: Platform
  kind: DonationKind
  authorId?: string
  value?: DonationValue
  headerText?: string
}): Donation {
  const built: Donation = {
    id: 'm1',
    channelId: 'youtube:vid',
    platform: over.platform ?? 'youtube',
    kind: over.kind,
    author: { id: over.authorId ?? 'member-1', displayName: 'Member' },
    timestamp: 1_700_000_000_000,
    value: over.value ?? { unit: 'count', count: 1 },
    text: '',
    read: false,
    streamerKey: 'mossflower'
  }
  if (over.headerText !== undefined) {
    built.headerText = over.headerText
  }
  return built
}

describe('membershipDedupKey', () => {
  it('gives one key to a purchase however many rooms announce it', () => {
    const inRoomA = donation({ kind: 'membership', headerText: 'Welcome!' })
    const inRoomB = donation({ kind: 'membership', headerText: 'Welcome!' })
    inRoomB.id = 'm2'
    inRoomB.channelId = 'youtube:other-vid'
    expect(membershipDedupKey(inRoomA, 'UC_creator')).toBe(
      membershipDedupKey(inRoomB, 'UC_creator')
    )
  })

  it('separates different creators, members, kinds, counts and wordings', () => {
    const base = donation({ kind: 'membership', headerText: 'Welcome!' })
    const key = membershipDedupKey(base, 'UC_creator')
    expect(membershipDedupKey(base, 'UC_other')).not.toBe(key)
    expect(
      membershipDedupKey(donation({ kind: 'membership', authorId: 'other' }), 'UC_creator')
    ).not.toBe(key)
    expect(membershipDedupKey(donation({ kind: 'membership_gift' }), 'UC_creator')).not.toBe(key)
    // A twenty-sub gift is not a repeat of a one-sub gift from the same person.
    const twenty = donation({ kind: 'membership_gift', value: { unit: 'count', count: 20 } })
    const one = donation({ kind: 'membership_gift', value: { unit: 'count', count: 1 } })
    expect(membershipDedupKey(twenty, 'UC_creator')).not.toBe(membershipDedupKey(one, 'UC_creator'))
    expect(membershipDedupKey(donation({ kind: 'membership' }), 'UC_creator')).not.toBe(key)
  })

  it('refuses to key money, which is never a duplicate announcement', () => {
    // Two Super Chats of the same amount from one viewer in two of a creator's rooms are two
    // payments; keying them would silently under-report income.
    const money: DonationValue = { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' }
    expect(
      membershipDedupKey(donation({ kind: 'superchat', value: money }), 'UC_c')
    ).toBeUndefined()
    expect(
      membershipDedupKey(donation({ kind: 'supersticker', value: money }), 'UC_c')
    ).toBeUndefined()
    expect(membershipDedupKey(donation({ kind: 'tip', value: money }), 'UC_c')).toBeUndefined()
  })

  it('refuses to key Twitch, which announces each event in its own chat only', () => {
    const giftSub = donation({ platform: 'twitch', kind: 'membership_gift' })
    expect(membershipDedupKey(giftSub, 'UC_creator')).toBeUndefined()
  })
})
