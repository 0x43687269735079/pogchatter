import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '@shared/model'
import type { Donation } from '@shared/donations'
import {
  applyDonationEvents,
  applyDonationsSnapshot,
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

describe('applyDonationsSnapshot', () => {
  it('keeps donations that arrived while the snapshot was in flight', () => {
    // The renderer subscribes to events before the snapshot resolves; replacing the list wholesale
    // discarded anything that landed in that window.
    const live = applyDonationEvents(EMPTY_DONATIONS, [added(donation('live', 5_000))])
    const merged = applyDonationsSnapshot(live, {
      donations: [donation('stored', 1_000)],
      rates: undefined,
      rateSource: undefined,
      baseCurrency: 'GBP',
      sessionStartedAt: 1
    })
    expect(merged.donations.map((d) => d.id)).toEqual(['live', 'stored'])
    expect(merged.baseCurrency).toBe('GBP')
  })

  it('prefers what the renderer already holds over the stored copy', () => {
    const readLocally = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000, true))])
    const merged = applyDonationsSnapshot(readLocally, {
      donations: [donation('a', 1_000, false)],
      rates: undefined,
      rateSource: undefined,
      baseCurrency: 'GBP',
      sessionStartedAt: 1
    })
    expect(merged.donations).toHaveLength(1)
    expect(merged.donations[0]?.read).toBe(true)
  })

  it('keeps live rates that arrived before the snapshot resolved', () => {
    // The snapshot is a one-time mount read; a rates fetch that completed during it is newer, so
    // merging must not revert to the snapshot's (absent, older) rates.
    const table = { base: 'EUR', rates: { JPY: 160 }, fetchedAt: 9, stale: false }
    const live = applyDonationEvents(EMPTY_DONATIONS, [
      { kind: 'rates', table, source: 'ExchangeRate-API' }
    ])
    const merged = applyDonationsSnapshot(live, {
      donations: [],
      rates: undefined,
      rateSource: undefined,
      baseCurrency: 'GBP',
      sessionStartedAt: 1
    })
    expect(merged.rates).toEqual(table)
    expect(merged.rateSource).toBe('ExchangeRate-API')
  })
})

describe('donations state follows the base currency and removals', () => {
  it('follows a base-currency event, independent of any rate table', () => {
    // The base is the user's setting, carried on its own event so the panel follows it even when no
    // rate table is available (offline) — a rate table only names the base it was *fetched* for.
    const state = applyDonationEvents(EMPTY_DONATIONS, [{ kind: 'baseCurrency', base: 'EUR' }])
    expect(state.baseCurrency).toBe('EUR')
  })

  it('records the provider a rates event names, for attribution', () => {
    const state = applyDonationEvents(EMPTY_DONATIONS, [
      {
        kind: 'rates',
        table: { base: 'GBP', rates: { JPY: 190 }, fetchedAt: 1, stale: false },
        source: 'ExchangeRate-API'
      }
    ])
    expect(state.rateSource).toBe('ExchangeRate-API')
  })

  it('does not let a rates event move the base off the chosen currency', () => {
    // A stale table can name an old base; adopting it would revert the panel's currency on a failed
    // refresh. The base must change only via a baseCurrency event.
    let state = applyDonationEvents(EMPTY_DONATIONS, [{ kind: 'baseCurrency', base: 'EUR' }])
    state = applyDonationEvents(state, [
      { kind: 'rates', table: { base: 'GBP', rates: { JPY: 190 }, fetchedAt: 1, stale: false } }
    ])
    expect(state.baseCurrency).toBe('EUR')
  })

  it('flags a donation whose message a moderator removed', () => {
    let state = applyDonationEvents(EMPTY_DONATIONS, [added(donation('a', 1_000))])
    state = applyDonationEvents(state, [{ kind: 'donationsRemoved', ids: ['a'] }])
    expect(state.donations[0]?.removed).toBe(true)
  })
})
