import type { ChatEvent } from '@shared/model'
import type { Donation, RateTable } from '@shared/donations'

/** The donations panel's view state: a projection of the store the main process owns. */
export interface DonationsState {
  /** Newest first, by the platform's own send time. */
  donations: Donation[]
  rates: RateTable | undefined
  rateSource: string | undefined
  baseCurrency: string
  /** App-start time; totals cover only donations at or after it. */
  sessionStartedAt: number
}

export const EMPTY_DONATIONS: DonationsState = {
  donations: [],
  rates: undefined,
  rateSource: undefined,
  baseCurrency: 'USD',
  sessionStartedAt: 0
}

/**
 * Fold a batch of events into the panel's state.
 *
 * Main owns the records and pushes every change, so this is a faithful projection rather than a
 * second source of truth — which is also why the unread badge is derived from this list instead of
 * being a separate number that could disagree with it.
 *
 * Returns `state` unchanged when nothing applied, so React can skip the re-render.
 */
export function applyDonationEvents(state: DonationsState, events: ChatEvent[]): DonationsState {
  let next = state
  for (const event of events) {
    if (event.kind === 'donation') {
      next = addDonation(next, event.donation)
    } else if (event.kind === 'donationsRead') {
      next = applyRead(next, event.ids, event.read)
    } else if (event.kind === 'rates') {
      next = { ...next, rates: event.table }
    }
  }
  return next
}

function addDonation(state: DonationsState, donation: Donation): DonationsState {
  if (state.donations.some((existing) => existing.id === donation.id)) {
    return state // a re-send or a replay: the store already has it
  }
  // Ordered by the platform's send time, not arrival, so a donation that reaches us late still
  // lands where it belongs. Usually that means the front, so scan from there.
  const index = state.donations.findIndex((existing) => existing.timestamp <= donation.timestamp)
  const donations = [...state.donations]
  donations.splice(index === -1 ? donations.length : index, 0, donation)
  return { ...state, donations }
}

function applyRead(state: DonationsState, ids: string[], read: boolean): DonationsState {
  const wanted = new Set(ids)
  let changed = false
  const donations = state.donations.map((donation) => {
    if (!wanted.has(donation.id) || donation.read === read) {
      return donation
    }
    changed = true
    return { ...donation, read }
  })
  return changed ? { ...state, donations } : state
}

/** How many donations still need acknowledging — the tab's badge. */
export function unreadCount(state: DonationsState): number {
  return state.donations.reduce((total, donation) => total + (donation.read ? 0 : 1), 0)
}
