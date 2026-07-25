import type { ChatMessage, Highlight } from '@shared/model'
import type { Donation, DonationKind, DonationValue } from '@shared/donations'
import { parseAmount } from '@shared/currencyParse'

/**
 * The single definition of "is this a donation" (spec FR-2). Every other part of the feature trusts
 * this gate, so widening what counts happens here and nowhere else.
 *
 * Highlight kinds that represent money or support qualify; `first_message` and anything without a
 * highlight do not. Twitch reports a bits count and a sub tier rather than a currency, so those
 * become non-money units — which is what stops the panel ever presenting one summed figure.
 */
const KINDS: Partial<Record<Highlight['kind'], DonationKind>> = {
  superchat: 'superchat',
  supersticker: 'supersticker',
  membership: 'membership',
  // Both a YouTube gifted membership and a Twitch gift sub normalise to this kind.
  membership_gift: 'membership_gift',
  bits: 'bits',
  subscription: 'subscription'
}

/** A donation for a qualifying message, else `undefined`. New donations start unread. */
export function donationFrom(message: ChatMessage, channelId: string): Donation | undefined {
  const highlight = message.highlight
  if (highlight === undefined) {
    return undefined
  }
  const kind = KINDS[highlight.kind]
  if (kind === undefined) {
    return undefined
  }
  const donation: Donation = {
    id: message.id,
    channelId,
    platform: message.platform,
    kind,
    author: { id: message.author.id, displayName: message.author.displayName },
    timestamp: message.timestamp,
    value: valueOf(kind, highlight),
    text: textOf(message),
    read: false
  }
  if (message.deleted === true) {
    donation.removed = true
  }
  return donation
}

/** What the platform gave us, in its own unit — never coerced into money it didn't state. */
function valueOf(kind: DonationKind, highlight: Highlight): DonationValue {
  if (kind === 'bits') {
    return { unit: 'bits', bits: highlight.amount ?? 0 }
  }
  if (kind === 'superchat' || kind === 'supersticker') {
    const original = highlight.displayAmount ?? ''
    const parsed = parseAmount(original)
    // No parse means no honest conversion: keep the platform's own string and say so downstream,
    // rather than guessing a currency and misstating money.
    return parsed === undefined
      ? { unit: 'money-unparsed', original }
      : { unit: 'money', amount: parsed.amount, currency: parsed.currency, original }
  }
  return { unit: 'count' }
}

/** The message body, or `''` for the events (memberships, most gifts) that carry none. */
function textOf(message: ChatMessage): string {
  return message.fragments
    .map((fragment) => (fragment.type === 'text' ? fragment.text : ''))
    .join('')
    .trim()
}
