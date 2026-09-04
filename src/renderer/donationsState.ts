import type { ChannelInfo, ChatEvent } from '@shared/model'
import { type Donation, DONATION_RETENTION, type RateTable } from '@shared/donations'

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
    } else if (event.kind === 'donationsRemoved') {
      next = applyRemoved(next, event.ids)
    } else if (event.kind === 'rates') {
      // Adopt the table and the provider that supplied it. The base is *not* taken from the table —
      // the table names the base it was fetched for, which lags the chosen base after a change and
      // reverts on a failed refresh; the base follows the dedicated baseCurrency event instead.
      next = { ...next, rates: event.table, rateSource: event.source ?? next.rateSource }
    } else if (event.kind === 'baseCurrency') {
      // The user's chosen conversion currency, resolved. Independent of the rate table so the panel
      // follows the setting even when no table is available.
      next = { ...next, baseCurrency: event.base }
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
  // Held to the same bound as the store, so a long session doesn't accumulate history that a
  // restart would then drop — the panel would otherwise promise more than it can keep.
  if (donations.length > DONATION_RETENTION) {
    donations.length = DONATION_RETENTION
  }
  return { ...state, donations }
}

/** Flag donations whose chat message a moderator removed; the donation itself still happened. */
function applyRemoved(state: DonationsState, ids: string[]): DonationsState {
  const wanted = new Set(ids)
  let changed = false
  const donations = state.donations.map((donation) => {
    if (!wanted.has(donation.id) || donation.removed === true) {
      return donation
    }
    changed = true
    return { ...donation, removed: true }
  })
  return changed ? { ...state, donations } : state
}

/**
 * Fold the opening snapshot in without losing donations that arrived while it was in flight.
 *
 * The renderer subscribes to live events before the snapshot resolves, so replacing the list
 * wholesale would discard anything that landed in that window — the same startup race `BacklogGate`
 * exists to solve for chat. Whatever the renderer already holds wins, since it is at least as new.
 */
export function applyDonationsSnapshot(
  state: DonationsState,
  snapshot: Omit<DonationsState, 'donations'> & { donations: Donation[] }
): DonationsState {
  const byId = new Map(snapshot.donations.map((donation) => [donation.id, donation]))
  for (const donation of state.donations) {
    byId.set(donation.id, donation)
  }
  const donations = [...byId.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, DONATION_RETENTION)
  // The snapshot is a one-time read taken at mount, so a rates event that completed while it was in
  // flight is newer: keep the live rates/source when the renderer already has them, rather than letting
  // the older snapshot overwrite them. Base and session start come from the snapshot (authoritative at
  // mount); a later baseCurrency event corrects the base if it changed.
  return {
    donations,
    rates: state.rates ?? snapshot.rates,
    rateSource: state.rateSource ?? snapshot.rateSource,
    baseCurrency: snapshot.baseCurrency,
    sessionStartedAt: snapshot.sessionStartedAt
  }
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

/** One streamer chip for the donations panel: its display label and unread count. */
export interface StreamerChip {
  key: string
  label: string
  unread: number
  /** Whether new paid events for this streamer are being collected (the tab-menu opt-in). */
  counted: boolean
}

/**
 * One chip per streamer the panel knows about: everyone represented in `donations`, newest
 * donation first, then every streamer being counted who has no donation yet — so the row always
 * shows who is being tracked, not only who has already paid.
 *
 * The label prefers an open channel's own label (a chat the user is actually watching) over the
 * bare key, so the chip reads like the rest of the UI; a streamer with no open channel (e.g. a
 * chat that's since been closed) falls back to the key itself rather than disappearing.
 */
export function streamerChips(
  donations: Donation[],
  channels: ChannelInfo[],
  counted: readonly string[] = []
): StreamerChip[] {
  const newest = new Map<string, number>()
  const unread = new Map<string, number>()
  for (const donation of donations) {
    const key = donation.streamerKey
    newest.set(key, Math.max(newest.get(key) ?? -Infinity, donation.timestamp))
    unread.set(key, (unread.get(key) ?? 0) + (donation.read ? 0 : 1))
  }
  const withDonations = [...newest.keys()].sort(
    (a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0)
  )
  const countedOnly = counted.filter((key) => !newest.has(key))
  return [...withDonations, ...countedOnly].map((key) => ({
    key,
    // A Twitch column is labelled by login; a YouTube column by stream title, which would mislabel
    // the whole streamer — so only a Twitch label is used, else the key itself.
    label:
      channels.find((channel) => channel.streamerKey === key && channel.platform === 'twitch')
        ?.label ?? key,
    unread: unread.get(key) ?? 0,
    counted: counted.includes(key)
  }))
}

/** The donations shown for a chip selection: everything for `'all'`, else just that streamer's. */
export function visibleDonations(donations: Donation[], selected: string | undefined): Donation[] {
  if (selected === undefined) {
    return donations
  }
  return donations.filter((donation) => donation.streamerKey === selected)
}
