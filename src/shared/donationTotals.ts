import type {
  Donation,
  DonationKind,
  DonationTotals,
  KindTotal,
  RateTable
} from '@shared/donations'
import { convert } from '@shared/currencyFormat'

/**
 * The session's donations summarised per platform and per kind.
 *
 * Broken down by kind rather than rolled up, so each line answers one question — how much came in as
 * Super Chats, how many stickers, how many new members, how many bits — instead of a single figure
 * that hides the mix.
 *
 * There is no combined figure at either level. Twitch reports a bits count and a sub tier, never a
 * currency, so anything spanning the two platforms would be an invented exchange rate between a
 * platform credit and money.
 *
 * `since` is the session start: donations older than it are ignored, so the totals describe tonight
 * rather than whatever history happens to be retained. `excluded` records donations left out because
 * their currency could not be identified or converted, so an incomplete money figure says so instead
 * of quietly understating.
 */
export function donationTotals(
  donations: readonly Donation[],
  rates: RateTable | undefined,
  base: string,
  since: number
): DonationTotals {
  const totals: DonationTotals = { youtube: {}, twitch: {} }
  for (const donation of donations) {
    if (donation.timestamp < since) {
      continue
    }
    const platform = totals[donation.platform]
    const entry = (platform[donation.kind] ??= emptyTotal())
    entry.count += 1
    if (donation.value.unit === 'bits') {
      entry.bits += donation.value.bits
      continue
    }
    if (donation.value.unit === 'count') {
      continue
    }
    const converted = convert(donation.value, rates, base)
    if (converted === undefined) {
      entry.excluded += 1
    } else {
      entry.converted += converted
    }
  }
  return totals
}

function emptyTotal(): KindTotal {
  return { count: 0, converted: 0, excluded: 0, bits: 0 }
}

/** How many donations of any kind were left out of a platform's money figure. */
export function excludedCount(platform: Partial<Record<DonationKind, KindTotal>>): number {
  return Object.values(platform).reduce((total, entry) => total + entry.excluded, 0)
}
