import type { Platform } from '@shared/model'

/**
 * The paid events the donations panel collects — the qualifying subset of `HighlightKind`, one for
 * one. Nothing else qualifies (see `donationFrom`).
 *
 * `membership_gift` is cross-platform: both a YouTube gifted membership and a Twitch gift sub
 * normalise to it, so the donation's `platform` is what distinguishes them, not a separate kind.
 */
export type DonationKind =
  | 'superchat'
  | 'supersticker'
  | 'membership'
  | 'membership_gift'
  | 'bits'
  | 'subscription'

/**
 * What the platform actually gave us, discriminated by unit.
 *
 * The variants exist so bits and money can never be added together: a single cross-platform figure
 * would imply a precision the data doesn't carry (Twitch reports a bits count and a sub tier, never a
 * currency), so the type makes summing them a compile error rather than a code-review question.
 *
 * `money-unparsed` is the honest outcome when a localised amount can't be resolved to a currency —
 * the original string is kept verbatim and the entry is excluded from converted totals.
 */
export type DonationValue =
  | { unit: 'money'; amount: number; currency: string; original: string }
  | { unit: 'money-unparsed'; original: string }
  | { unit: 'bits'; bits: number }
  | { unit: 'count' }

/** One collected paid event. `id` is the platform's message id — both the dedup and read-state key. */
export interface Donation {
  id: string
  channelId: string
  platform: Platform
  kind: DonationKind
  author: { id: string; displayName: string }
  /** The platform's own send time, so ordering survives out-of-order arrival. */
  timestamp: number
  value: DonationValue
  /** The message body, or `''` for events that carry none (most memberships and gifts). */
  text: string
  read: boolean
  /** Set once a moderator removes the message from chat; the donation itself still happened. */
  removed?: boolean
}

/** Exchange rates for one base currency, as fetched and cached by the main process. */
export interface RateTable {
  base: string
  /** Units of each currency per 1 unit of `base`. */
  rates: Record<string, number>
  fetchedAt: number
  /** True when serving a cache that could not be refreshed — shown to the user, never hidden. */
  stale: boolean
}

/** Per-platform totals. Deliberately no combined field — see {@link DonationValue}. */
export interface DonationTotals {
  youtube: {
    /** Summed in the base currency. */
    converted: number
    /** Donations left out because their currency could not be identified or converted. */
    excluded: number
    memberships: number
  }
  twitch: { bits: number; subs: number }
}

/**
 * Donations retained before the oldest ages out. A bounded ring keeps the store small enough to load
 * eagerly at startup while covering many streams' worth of history.
 */
export const DONATION_RETENTION = 1000

/** The donations tab's fixed column id, alongside the flagged view's. */
export const DONATIONS_COLUMN_ID = 'donations'

/** Everything the donations panel needs to open, fetched once on mount. */
export interface DonationsSnapshot {
  donations: Donation[]
  rates: RateTable | undefined
  /** Which provider supplied the rates, for the attribution line. */
  rateSource: string | undefined
  /** The resolved currency to convert into (the setting, or the OS locale when unset). */
  baseCurrency: string
  /** App-start time — totals cover this session only, and a renderer reload must not reset it. */
  sessionStartedAt: number
}
