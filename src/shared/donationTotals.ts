import type { Donation, DonationTotals, RateTable } from '@shared/donations'
import { convert } from '@shared/currencyFormat'

/**
 * Per-platform totals for the current session.
 *
 * There is deliberately no combined figure. Twitch reports a bits count and a sub tier, never a
 * currency, so any single number spanning both platforms would be an invented exchange rate between
 * a platform credit and money — see {@link DonationTotals}.
 *
 * `since` is the session start: donations older than it are ignored entirely, so the totals answer
 * "how is tonight going" rather than summing whatever history happens to be retained. `excluded`
 * counts the YouTube donations left out because their currency could not be identified or converted,
 * so the panel can disclose that its money figure is incomplete instead of quietly understating.
 */
export function donationTotals(
  donations: readonly Donation[],
  rates: RateTable | undefined,
  base: string,
  since: number
): DonationTotals {
  const totals: DonationTotals = {
    youtube: { converted: 0, excluded: 0, memberships: 0 },
    twitch: { bits: 0, subs: 0 }
  }
  for (const donation of donations) {
    if (donation.timestamp < since) {
      continue
    }
    if (donation.platform === 'twitch') {
      addTwitch(totals, donation)
    } else {
      addYouTube(totals, donation, rates, base)
    }
  }
  return totals
}

function addTwitch(totals: DonationTotals, donation: Donation): void {
  if (donation.value.unit === 'bits') {
    totals.twitch.bits += donation.value.bits
    return
  }
  if (donation.kind === 'subscription' || donation.kind === 'membership_gift') {
    totals.twitch.subs += 1
  }
}

function addYouTube(
  totals: DonationTotals,
  donation: Donation,
  rates: RateTable | undefined,
  base: string
): void {
  if (donation.kind === 'membership' || donation.kind === 'membership_gift') {
    totals.youtube.memberships += 1
    return
  }
  const converted = convert(donation.value, rates, base)
  if (converted === undefined) {
    totals.youtube.excluded += 1
    return
  }
  totals.youtube.converted += converted
}
