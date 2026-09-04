import type { Donation } from '@shared/donations'

/**
 * A key identifying one YouTube membership purchase, independent of the message that announced it.
 *
 * YouTube announces a membership or gift in every live chat the creator has open, giving each
 * announcement its own message id. Two of that creator's streams watched at once therefore produce
 * two records of one purchase, and the store's id check cannot see it: the ids genuinely differ.
 *
 * The key is the creator plus everything about the event that the announcements share — who joined,
 * what kind of event, how many memberships, and YouTube's own wording for it. Money kinds are
 * excluded deliberately: two Super Chats of the same amount from the same viewer in two of a
 * creator's rooms are two payments, and collapsing them would under-report real income.
 *
 * Args:
 *   donation: The donation just built from the announcement.
 *   creatorId: The YouTube channel id the chat belongs to — the same value for every room of one
 *     creator, which is what makes cross-room duplicates comparable.
 *
 * Returns:
 *   The key, or `undefined` when this donation is not a YouTube membership event and so must never
 *   be deduplicated this way.
 */
export function membershipDedupKey(donation: Donation, creatorId: string): string | undefined {
  if (donation.platform !== 'youtube') {
    return undefined
  }
  if (donation.kind !== 'membership' && donation.kind !== 'membership_gift') {
    return undefined
  }
  // A twenty-sub gift and a one-sub gift from the same person moments apart are distinct purchases,
  // so the count is part of the identity rather than something the window collapses.
  const count = donation.value.unit === 'count' ? donation.value.count : 1
  const headerText = donation.headerText ?? ''
  return `${creatorId}:${donation.kind}:${donation.author.id}:${count}:${headerText}`
}
