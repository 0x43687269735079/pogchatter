import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '@shared/model'
import type { Donation } from '@shared/donations'
import {
  applyDonationEvents,
  type DonationsState,
  EMPTY_DONATIONS,
  unreadCount
} from '@renderer/donationsState'

function donation(id: string, timestamp: number, read = false): Donation {
  return {
    id,
    channelId: 'yt:vid',
    platform: 'youtube',
    kind: 'superchat',
    author: { id: 'u', displayName: 'U' },
    timestamp,
    value: { unit: 'money', amount: 5, currency: 'GBP', original: '£5.00' },
    text: '',
    read
  }
}

const added = (d: Donation): ChatEvent => ({ kind: 'donation', donation: d })

describe('applyDonationEvents', () => {
  it('adds a donation to the front of the feed', () => {
    const state = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000))])
    expect(state.donations.map((d) => d.id)).toEqual(['a'])
  })

  it('ignores a donation it already has, however often it is re-sent', () => {
    const once = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000))])
    const twice = applyDonationEvents(once, [added(donation('a', 1_000))])
    expect(twice.donations).toHaveLength(1)
    expect(twice).toBe(once) // unchanged reference, so React can skip the render
  })

  it('orders by the platform send time even when events arrive out of order', () => {
    const state = applyDonationEvents(EMPTY_DONATIONS, [
      added(donation('newest', 3_000)),
      added(donation('oldest', 1_000)),
      added(donation('middle', 2_000))
    ])
    expect(state.donations.map((d) => d.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('flips exactly the ids a read event names', () => {
    let state = applyDonationEvents(EMPTY_DONATIONS, [
      added(donation('a', 1_000)),
      added(donation('b', 2_000))
    ])
    state = applyDonationEvents(state, [{ kind: 'donationsRead', ids: ['a'], read: true }])
    expect(state.donations.find((d) => d.id === 'a')?.read).toBe(true)
    expect(state.donations.find((d) => d.id === 'b')?.read).toBe(false)
  })

  it('can mark a donation unread again', () => {
    let state = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000, true))])
    state = applyDonationEvents(state, [{ kind: 'donationsRead', ids: ['a'], read: false }])
    expect(state.donations[0]?.read).toBe(false)
  })

  it('returns the same state when a read event changes nothing', () => {
    const state = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000))])
    expect(applyDonationEvents(state, [{ kind: 'donationsRead', ids: ['a'], read: false }])).toBe(
      state
    )
    expect(applyDonationEvents(state, [{ kind: 'donationsRead', ids: ['nope'], read: true }])).toBe(
      state
    )
  })

  it('takes new rates as they arrive', () => {
    const table = { base: 'GBP', rates: { JPY: 190 }, fetchedAt: 1, stale: false }
    const state = applyDonationEvents(EMPTY_DONATIONS, [{ kind: 'rates', table }])
    expect(state.rates).toEqual(table)
  })

  it('ignores events that are not its own', () => {
    const state: DonationsState = { ...EMPTY_DONATIONS }
    expect(applyDonationEvents(state, [{ kind: 'channels', channels: [] }])).toBe(state)
  })
})

describe('unreadCount', () => {
  it('counts only what still needs acknowledging', () => {
    const state = applyDonationEvents(EMPTY_DONATIONS, [
      added(donation('a', 1_000, true)),
      added(donation('b', 2_000)),
      added(donation('c', 3_000))
    ])
    expect(unreadCount(state)).toBe(2)
    expect(unreadCount(EMPTY_DONATIONS)).toBe(0)
  })
})
